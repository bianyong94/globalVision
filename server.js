// server.js - 终极版 (并发竞速 + 熔断 + 演员搜索 + Redis缓存)
require("dotenv").config()
const express = require("express")
const axios = require("axios")
const cors = require("cors")
const NodeCache = require("node-cache")
const mongoose = require("mongoose")
const http = require("http")
const https = require("https")
const compression = require("compression")
const rateLimit = require("express-rate-limit")
const { HttpsProxyAgent } = require("https-proxy-agent")
const Redis = require("ioredis") // ✨ 新增：引入 Redis
const Video = require("./models/Video") // 确保路径正确

// 引入源配置
const { sources, PRIORITY_LIST } = require("./config/sources")

const app = express()
const PORT = process.env.PORT || 3000

// ==========================================
// 0. 缓存系统初始化 (Redis + 内存降级)
// ==========================================

// 本地内存缓存 (作为 Redis 的兜底方案)
const localCache = new NodeCache({ stdTTL: 600, checkperiod: 120 })
let redisClient = null

// 尝试连接 Redis (Zeabur 会自动注入 REDIS_CONNECTION_STRING)
if (process.env.REDIS_CONNECTION_STRING) {
  redisClient = new Redis(process.env.REDIS_CONNECTION_STRING)
  redisClient.on("connect", () => console.log("✅ Redis Cache Connected"))
  redisClient.on("error", (err) => {
    console.error("❌ Redis Error (Falling back to memory):", err.message)
    // 如果 Redis 挂了，可以在这里做降级逻辑，目前 ioredis 会自动重连
  })
} else {
  console.log("⚠️ No Redis Config found, using Memory Cache")
}

// 📦 统一缓存封装函数 (核心)
const getCache = async (key) => {
  try {
    if (redisClient) {
      const data = await redisClient.get(key)
      return data ? JSON.parse(data) : null
    }
    return localCache.get(key)
  } catch (e) {
    return null // 出错时不阻塞流程，视为无缓存
  }
}

const setCache = async (key, data, ttlSeconds = 600) => {
  try {
    if (redisClient) {
      // Redis SETEX: key, seconds, value
      await redisClient.set(key, JSON.stringify(data), "EX", ttlSeconds)
    } else {
      localCache.set(key, data, ttlSeconds)
    }
  } catch (e) {
    console.error("Set Cache Error:", e)
  }
}

// ==========================================
// 1. 安全与配置
// ==========================================

app.use(compression())

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { code: 429, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
})
app.use("/api/", limiter)

const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { code: 429, message: "AI Busy" },
})

const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? [
          process.env.FRONTEND_URL,
          "https://maizi93.zeabur.app",
          "https://global-vision-web.vercel.app",
          "https://www.bycurry.cc", // 你的新前端
          "https://bycurry.cc", // 你的根域名
        ]
      : "*",
  optionsSuccessStatus: 200,
}
app.use(cors(corsOptions))
app.use(express.json())

// ==========================================
// 2. 数据库与网络代理
// ==========================================

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
})

const MONGO_URI = process.env.MONGO_URI
if (MONGO_URI) {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Database Connected"))
    .catch((err) => console.error("❌ MongoDB Connection Error:", err))
}

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  history: { type: Array, default: [] },
  favorites: { type: Array, default: [] },
  createdAt: { type: Date, default: Date.now },
})
UserSchema.index({ username: 1 })
const User = mongoose.model("User", UserSchema)

// ==========================================
// 3. 智能调度 (熔断+竞速)
// ==========================================

const sourceHealth = {}
PRIORITY_LIST.forEach((key) => {
  sourceHealth[key] = { failCount: 0, deadUntil: 0 }
})

const markSourceFailed = (key) => {
  const health = sourceHealth[key]
  health.failCount++
  if (health.failCount >= 3) {
    health.deadUntil = Date.now() + 5 * 60 * 1000
    console.warn(`🔥 [熔断] 源 ${key} 暂停使用 5分钟`)
  } else if (health.failCount >= 2) {
    health.deadUntil = Date.now() + 30 * 1000
  }
}

const markSourceSuccess = (key) => {
  if (sourceHealth[key].failCount > 0) {
    sourceHealth[key].failCount = 0
    sourceHealth[key].deadUntil = 0
  }
}

const getAxiosConfig = () => {
  const config = {
    timeout: 5000,
    httpAgent,
    httpsAgent,
    proxy: false,
  }
  if (process.env.PROXY_URL)
    config.httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL)
  return config
}

/**
 * 🚀 智能并发请求 (升级版)
 * @param paramsFn 参数生成函数
 * @param options 配置项: 可以是字符串(指定源Key) 或者 对象 { key: string, scanAll: boolean }
 */
/**
 * 🚀 智能并发请求 (升级版 - 带测速)
 */
const smartFetch = async (paramsFn, options = null) => {
  let targetKeys = []

  // ... (保留原有的 key 选择逻辑，这部分不变) ...
  const specificSourceKey = typeof options === "string" ? options : options?.key
  const scanAll = typeof options === "object" ? options?.scanAll : false

  if (specificSourceKey) {
    targetKeys = [specificSourceKey]
  } else {
    const healthyKeys = PRIORITY_LIST.filter(
      (key) => sourceHealth[key].deadUntil <= Date.now()
    )
    if (scanAll) {
      targetKeys = healthyKeys
    } else {
      targetKeys = healthyKeys.slice(0, 3)
    }
  }

  if (targetKeys.length === 0) targetKeys = [PRIORITY_LIST[0]]

  //Map 请求任务
  const requests = targetKeys.map(async (key) => {
    const source = sources[key]
    if (!source) throw new Error("Config missing")

    try {
      const params = paramsFn(source)

      // ⏱️ [新增] 开始计时
      const startTime = Date.now()

      const response = await axios.get(source.url, {
        params,
        ...getAxiosConfig(),
      })

      // ⏱️ [新增] 结束计时 & 计算耗时
      const duration = Date.now() - startTime

      if (
        response.data &&
        response.data.list &&
        response.data.list.length > 0
      ) {
        markSourceSuccess(key)
        // ✅ [新增] 返回 duration (耗时)
        return {
          data: response.data,
          sourceName: source.name,
          sourceKey: key,
          duration: duration, // 单位 ms
        }
      } else {
        throw new Error("Empty Data")
      }
    } catch (err) {
      if (!specificSourceKey) markSourceFailed(key)
      throw err
    }
  })

  try {
    return await Promise.any(requests)
  } catch (err) {
    throw new Error("所有线路繁忙或无数据")
  }
}

// ==========================================
// 4. 数据处理工具
// ==========================================

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

const processVideoList = (list, sourceKey, limit = 12) => {
  if (!list || !Array.isArray(list)) return []

  const processed = list.map((item) => ({
    id: `${sourceKey}$${item.vod_id}`,
    // id: `${sourceKey}$${item.vod_id}`,
    title: item.vod_name,
    type: item.type_name,
    poster: item.vod_pic,
    remarks: item.vod_remarks,
    year: parseInt(item.vod_year) || 0,
    rating: parseFloat(item.vod_score) || 0.0,
    date: item.vod_time,
    actors: item.vod_actor || "",
    director: item.vod_director || "",
  }))

  processed.sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year
    return b.rating - a.rating
  })

  return limit ? processed.slice(0, limit) : processed
}

// ==========================================
// 5. API 路由 (已集成 Redis)
// ==========================================

// [首页聚合] - 最终完整版 (含电影、剧集、动漫、综艺、纪录片、体育)
app.get("/api/home/trending", async (req, res) => {
  const cacheKey = "home_dashboard_v9" // 升级版本号

  // 1. 尝试从缓存取
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    // 🛠️ 辅助函数1：根据标准 ID 找映射 ID (用于综艺/纪录片)
    const fetchByStdId = (stdId) =>
      smartFetch((s) => ({
        ac: "detail",
        at: "json",
        pg: 1,
        t: s.id_map && s.id_map[stdId] ? s.id_map[stdId] : stdId,
      }))

    // 🛠️ 辅助函数2：根据 home_map 配置取 ID (用于电影/剧集/动漫)
    const fetchByMap = (mapKey) =>
      smartFetch((s) => ({
        ac: "detail",
        at: "json",
        pg: 1,
        t: s.home_map[mapKey],
      }))

    // 🛠️ 辅助函数3：按关键词搜索 (专门用于体育，因为体育没有固定ID)
    const fetchByKeyword = (keyword) =>
      smartFetch(
        () => ({
          ac: "detail",
          at: "json",
          pg: 1,
          wd: keyword,
        }),
        { scanAll: true } // 👈 开启扫荡模式，直到找到有 NBA 的源为止
      )

    // 🚀 并发请求 7 个任务
    const results = await Promise.allSettled([
      smartFetch(() => ({ ac: "detail", at: "json", pg: 1, h: 24 })), // 0. 最新 Banner
      fetchByMap("movie_hot"), // 1. 电影
      fetchByMap("tv_cn"), // 2. 剧集
      fetchByMap("anime"), // 3. 动漫
      fetchByStdId(3), // 4. 综艺 (标准ID 3)
      fetchByStdId(20), // 5. 纪录片 (标准ID 20)
      fetchByKeyword("NBA"), // 6. 体育 (搜 NBA 最稳，或者搜"篮球")
    ])

    // 数据提取与清洗
    const extract = (result, limit) => {
      if (!result) return []
      if (result.status === "fulfilled") {
        return processVideoList(
          result.value.data.list,
          result.value.sourceKey,
          limit
        )
      }
      return [] // 失败返回空数组
    }

    const data = {
      banners: extract(results[0], 5),
      movies: extract(results[1], 12),
      tvs: extract(results[2], 12),
      animes: extract(results[3], 12),
      varieties: extract(results[4], 12), // 综艺
      documentaries: extract(results[5], 12), // 纪录片
      sports: extract(results[20], 12), // 体育 (新增)
    }

    // 2. 存入缓存
    await setCache(cacheKey, data, 600)

    success(res, data)
  } catch (e) {
    console.error("Home Fatal Error:", e)
    fail(res, "首页服务繁忙，请稍后重试")
  }
})

// [混合搜索] - 本地 + 网络互补
app.get("/api/videos", async (req, res) => {
  const { wd } = req.query // 搜索词

  try {
    // 1. 先搜本地 MongoDB (支持搜演员、导演、片名)
    let localList = await Video.find({
      $or: [
        { title: { $regex: wd, $options: "i" } },
        { actors: { $regex: wd, $options: "i" } },
      ],
    })
      .limit(20)
      .lean() // .lean() 转为普通 JS 对象方便修改

    // 2. 标记本地数据来源 (给前端看)
    localList = localList.map((v) => ({ ...v, source: "Local" }))

    // 3. 如果本地结果少于 5 个，认为可能库不全，触发 API 搜索补充
    if (localList.length < 5) {
      console.log(`本地结果仅 ${localList.length} 条，触发 API 补充搜索...`)

      try {
        // 调用之前的 smartFetch 去源站搜
        const apiResult = await smartFetch(() => ({ ac: "detail", wd: wd }))
        const apiList = processVideoList(
          apiResult.data.list,
          apiResult.sourceKey
        )

        // 4. 合并数据 & 去重
        // 简单的去重逻辑：如果 API 返回的片名在本地已经有了，就不要了
        const localTitles = new Set(localList.map((v) => v.title))

        for (const item of apiList) {
          if (!localTitles.has(item.title)) {
            localList.push(item)
          }
        }
      } catch (err) {
        // API 搜不到也没关系，至少有本地的
        console.log("API 补充搜索失败或无结果")
      }
    }

    success(res, {
      list: localList,
      total: localList.length,
      source: "Hybrid (Local + API)",
    })
  } catch (e) {
    fail(res, "搜索出错")
  }
})

// [本地增强搜索] - 支持搜片名和演员
app.get("/api/local/search", async (req, res) => {
  const { q, page = 1, limit = 20 } = req.query

  if (!q) return fail(res, "缺少关键词", 400)

  try {
    // 构造查询条件：片名包含 OR 演员包含 OR 导演包含
    const query = {
      $or: [
        { title: { $regex: q, $options: "i" } }, // i 表示忽略大小写
        { actors: { $regex: q, $options: "i" } },
        { director: { $regex: q, $options: "i" } },
      ],
    }

    const skip = (page - 1) * limit

    // 并行查询：查列表 + 查总数
    const [list, total] = await Promise.all([
      Video.find(query)
        .select("id title poster type year remarks rating actors") // 只取列表需要的字段
        .sort({ year: -1, updatedAt: -1 }) // 按年份倒序
        .skip(skip)
        .limit(parseInt(limit)),
      Video.countDocuments(query),
    ])

    success(res, {
      list,
      total,
      page: parseInt(page),
      pagecount: Math.ceil(total / limit),
      source: "Local Database", // 标记数据来源
    })
  } catch (e) {
    console.error("Local Search Error:", e)
    fail(res, "本地搜索失败")
  }
})

// [详情] - 修复 500 错误，增加容错

// [详情] - 数据库优先 + 自动补全策略
app.get("/api/detail/:id", async (req, res) => {
  const { id } = req.params

  // 🛠️ 提取公共解析函数，避免重复代码
  const parseEpisodes = (urlStr, fromStr) => {
    if (!urlStr) return []
    const froms = (fromStr || "").split("$$$")
    const urls = urlStr.split("$$$")
    // 优先找 m3u8，找不到就用第一个
    let idx = froms.findIndex((f) => f && f.toLowerCase().includes("m3u8"))
    if (idx === -1) idx = 0
    const targetUrl = urls[idx] || ""
    if (!targetUrl) return []
    return targetUrl.split("#").map((ep) => {
      const parts = ep.split("$")
      return {
        name: parts.length > 1 ? parts[0] : "正片",
        link: parts.length > 1 ? parts[1] : parts[0],
      }
    })
  }

  // 1. 尝试从 MongoDB 获取
  try {
    const localVideo = await Video.findOne({ id: id })
    if (localVideo) {
      // ✅ 命中数据库！直接返回
      res.setHeader("X-Data-Source", "MongoDB")
      return success(res, {
        ...localVideo.toObject(),
        episodes: parseEpisodes(
          localVideo.vod_play_url,
          localVideo.vod_play_from
        ),
        latency: 0, // 本地读取延迟极低
      })
    }
  } catch (e) {
    console.error("DB Read Error:", e)
    // 数据库读失败不应阻塞，继续走下面的 API 请求
  }

  // ============================================
  // ⬇️ 以下是 API 回源请求逻辑 (Fallback)
  // ============================================

  let sourceKey = PRIORITY_LIST[0]
  let vodId = id

  if (id.includes("$")) {
    const parts = id.split("$")
    sourceKey = parts[0]
    vodId = parts[1]
  }

  try {
    if (!sources[sourceKey]) sourceKey = PRIORITY_LIST[0]

    const result = await smartFetch(
      () => ({
        ac: "detail",
        at: "json",
        ids: vodId,
      }),
      sourceKey
    )

    if (
      !result ||
      !result.data ||
      !result.data.list ||
      result.data.list.length === 0
    ) {
      return fail(res, "源站未返回数据", 404)
    }

    const detail = result.data.list[0]

    // 2. ✨ 核心逻辑：将 API 查到的数据保存到 MongoDB
    // 构造数据对象 (记得加上 type_id)
    const videoData = {
      id: `${sourceKey}$${detail.vod_id}`,
      title: detail.vod_name,
      // 🔴 关键修复：保存 type_id，修复分类搜索
      type_id: parseInt(detail.type_id) || 0,
      type: detail.type_name,
      poster: detail.vod_pic,
      remarks: detail.vod_remarks,
      year: detail.vod_year,
      rating: parseFloat(detail.vod_score) || 0,
      date: detail.vod_time,
      actors: detail.vod_actor || "",
      director: detail.vod_director || "",
      overview: (detail.vod_content || "").replace(/<[^>]+>/g, "").trim(),
      vod_play_from: detail.vod_play_from,
      vod_play_url: detail.vod_play_url,
      updatedAt: new Date(),
    }

    // 异步更新/插入 (使用 updateOne + upsert 防止并发冲突)
    Video.updateOne({ id: videoData.id }, { $set: videoData }, { upsert: true })
      .then(() => console.log(`💾 Auto-saved: ${videoData.title}`))
      .catch((err) => console.error("Auto-Save failed:", err.message))

    // 3. 返回给前端
    success(res, {
      id: videoData.id,
      title: videoData.title,
      overview: videoData.overview,
      poster: videoData.poster,
      type: videoData.type,
      area: detail.vod_area,
      year: videoData.year,
      director: videoData.director,
      actors: videoData.actors,
      remarks: videoData.remarks,
      rating: videoData.rating,
      episodes: parseEpisodes(detail.vod_play_url, detail.vod_play_from),

      // ✅ 返回源信息和速度
      source: result.sourceName,
      latency: result.duration,
    })
  } catch (e) {
    console.error("Detail Error:", e.message)
    fail(res, "资源获取失败或源站超时", 404)
  }
})
// [分类] - 使用 Redis 缓存
app.get("/api/categories", async (req, res) => {
  const cacheKey = "categories_list"

  // ✨ 1. 尝试从缓存取
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    const result = await smartFetch(() => ({ ac: "list", at: "json" }))
    const rawClass = result.data.class || []
    const safeClass = rawClass.filter(
      (c) => !["伦理", "福利", "激情", "论理"].includes(c.type_name)
    )

    // ✨ 2. 存入缓存 (24小时)
    await setCache(cacheKey, safeClass, 86400)

    success(res, safeClass)
  } catch (e) {
    success(res, [])
  }
})

// [User & AI] 保持不变
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body
  try {
    const existing = await User.findOne({ username })
    if (existing) return fail(res, "用户已存在", 400)
    const newUser = new User({ username, password })
    await newUser.save()
    success(res, { id: newUser._id, username })
  } catch (e) {
    fail(res, "注册失败")
  }
})

app.get("/api/user/history", async (req, res) => {
  const { username } = req.query
  if (!username) return success(res, [])

  try {
    const user = await User.findOne({ username })
    if (!user) return success(res, [])

    // ✨ 优化：读取时过滤掉数据结构损坏的脏记录 (比如没有 id 或 title 的)
    const validHistory = (user.history || []).filter(
      (item) => item && item.id && item.title
    )

    // 如果发现脏数据，顺便在后台清洗一下数据库 (可选，为了性能暂不存回库)
    success(res, validHistory)
  } catch (e) {
    console.error("Get History Error:", e)
    success(res, [])
  }
})

// [用户历史] - 修复更新集数不生效的问题
app.post("/api/user/history", async (req, res) => {
  const { username, video, episodeIndex, progress } = req.body
  if (!username || !video || !video.id) return fail(res, "参数错误", 400)

  try {
    const user = await User.findOne({ username })
    if (!user) return fail(res, "用户不存在", 404)

    // 清洗 ID：确保 ID 格式一致（全部转为字符串）
    const targetId = String(video.id)
    // 尝试提取纯数字 ID 用于模糊匹配 (解决旧数据 "123" 和新数据 "liangzi$123" 不匹配的问题)
    const rawId = targetId.includes("$") ? targetId.split("$")[1] : targetId

    // 1. 过滤掉旧记录
    // 逻辑：只要 ID 完全相等，或者 ID 的后缀数字相等，都视为同一个视频，删掉旧的
    let newHistory = (user.history || []).filter((h) => {
      const hId = String(h.id)
      const hRawId = hId.includes("$") ? hId.split("$")[1] : hId
      return hId !== targetId && hRawId !== rawId
    })

    // 2. 构造新记录
    const historyItem = {
      ...video,
      id: targetId, // 确保存入的是最新的带前缀 ID
      episodeIndex: parseInt(episodeIndex) || 0, // 强制转数字
      progress: parseFloat(progress) || 0, // 强制转数字
      viewedAt: new Date().toISOString(),
    }

    // 3. 插入头部
    newHistory.unshift(historyItem)
    user.history = newHistory.slice(0, 50)

    // 4. 强制标记修改 (Mongoose 对混合类型数组有时检测不到变化)
    user.markModified("history")
    await user.save()

    console.log(
      `✅ [History] ${username} -> ${video.title} (Ep:${episodeIndex})`
    )
    success(res, user.history)
  } catch (e) {
    console.error("History Save Error:", e)
    fail(res, "保存失败")
  }
})

// 清空历史记录
app.delete("/api/user/history", async (req, res) => {
  const { username } = req.query // 使用 query 参数传递用户名
  if (!username) return fail(res, "用户名不能为空", 400)

  try {
    const user = await User.findOne({ username })
    if (!user) return fail(res, "用户不存在", 404)

    // 直接清空数组
    user.history = []

    // 标记修改并保存
    user.markModified("history")
    await user.save()

    console.log(`🗑️ [History] Cleared for ${username}`)
    success(res, [])
  } catch (e) {
    console.error("Clear History Error:", e)
    fail(res, "清空失败")
  }
})

const AI_API_KEY = process.env.AI_API_KEY
const AI_API_URL = "https://api.siliconflow.cn/v1/chat/completions"

// server.js AI 接口部分修改
// [AI Search] 深度优化版
// 确保 .env 里配置了 AI_API_KEY (推荐使用硅基流动的 Key)

app.post("/api/ai/ask", aiLimiter, async (req, res) => {
  const { question } = req.body

  if (!AI_API_KEY) return fail(res, "服务端未配置 AI Key", 500)
  if (!question) return fail(res, "请输入问题", 400)

  // 1. 获取当前日期，让 AI 知道“现在”是什么时候
  const today = new Date()
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月`

  try {
    const response = await axios.post(
      AI_API_URL,
      {
        // ✨ 切换到 DeepSeek-V3 (更聪明，知识更新)
        // 如果报错模型不存在，请检查硅基流动官网支持的模型列表，或者回退到 Qwen/Qwen2.5-7B-Instruct
        model: "deepseek-ai/DeepSeek-V3",
        messages: [
          {
            role: "system",
            content: `你是一个精通全网影视资源的搜索助手。
            当前时间是：${dateStr}。
            
            用户的意图是：通过你提供的关键词，去国内的影视资源站（如Maccms）进行搜索播放。
            
            请严格遵守以下规则：
            1. **时效性优先**：如果用户问“最新”、“近期”热门，必须推荐 ${today.getFullYear()} 年或 ${
              today.getFullYear() - 1
            } 年上映的作品。绝对不要推荐老片，除非用户明确要求。
            2. **搜索匹配率优先**：国内资源站通常只收录【中文译名】。
               - 如果是欧美/日韩片，必须返回【国内最通用的中文译名】（例如返回"复仇者联盟"而不是"The Avengers"）。
               - 只有当你确定该片在国内通常以英文名存档时，才返回英文。
            3. **格式限制**：直接返回 3 到 6 个影片名称，用英文逗号 "," 分隔。
            4. **严禁废话**：不要返回任何前缀、后缀、推荐理由或标点符号。
            
            示例输入："推荐几部好看的科幻片"
            示例输出："沙丘2,流浪地球2,阿凡达：水之道,星际穿越"`,
          },
          { role: "user", content: question },
        ],
        stream: false,
        max_tokens: 100,
        temperature: 0.6, // 稍微提高一点创造性，防止死板
      },
      {
        headers: {
          Authorization: `Bearer ${AI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15000, // DeepSeek 有时思考较久
      }
    )

    const content = response.data.choices[0].message.content

    // 数据清洗：移除可能存在的句号、书名号等干扰搜索的符号
    const recommendations = content
      .replace(/[。.!！《》\n]/g, "")
      .split(/,|，/)
      .map((s) => s.trim())
      .filter((s) => s && s.length < 30) // 过滤掉过长的异常结果

    success(res, recommendations)
  } catch (error) {
    console.error("AI Error:", error.response?.data || error.message)

    // 降级策略：如果 DeepSeek 挂了或者超时，返回一个固定的热门列表，防止前端空白
    // 这里的列表可以根据实际情况写几个万能热门
    const fallback = ["庆余年2", "抓娃娃", "死侍与金刚", "默杀", "异形：夺命舰"]
    success(res, fallback)
  }
})

// ==========================================
// [补全] 用户认证接口 (Login & Register)
// ==========================================

// 注册
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body
  try {
    const existing = await User.findOne({ username })
    if (existing) return fail(res, "用户已存在", 400)

    // 注意：生产环境建议这里使用 bcrypt 对 password 进行加密后再存
    const newUser = new User({ username, password })
    await newUser.save()

    success(res, { id: newUser._id, username })
  } catch (e) {
    console.error("Register Error:", e)
    fail(res, "注册失败")
  }
})

// 登录
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body
  try {
    // 1. 查找用户
    const user = await User.findOne({ username, password })

    if (!user) {
      return fail(res, "账号或密码错误", 401)
    }

    // 2. 返回用户信息 (不返回密码)
    success(res, {
      id: user._id,
      username: user.username,
      // 如果有头像或其他字段也可以在这里返回
    })
  } catch (e) {
    console.error("Login Error:", e)
    fail(res, "登录失败")
  }
})

// server.js 顶部引入
const cron = require("node-cron")
const { startSync } = require("./scripts/sync") // 把 sync.js 封装成函数导出

// ... 你的其他路由代码 ...

// ⏰ 定时任务：每天凌晨 2:00 执行采集
// 格式：分 时 日 月 周
cron.schedule("0 2 * * *", () => {
  console.log("⏰ 定时任务启动：开始同步数据...")
  // 调用你的采集函数
  startSync().catch((err) => console.error("同步失败:", err))
})

app.use((err, req, res, next) => {
  console.error("Global Error:", err)
  res.status(500).json({ code: 500, message: "Server Internal Error" })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Server running on port ${PORT}`)
  console.log(`🛡️  Mode: Production | RateLimit: ON | Redis: Supported`)
})
