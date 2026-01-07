// server.js - 终极版 (混合搜索 + 智能分类清洗 + Redis缓存 + 首页熔断保护)
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
const Redis = require("ioredis")
const Video = require("./models/Video") // 确保 ./models/Video.js 存在
const { exec } = require("child_process")
const { syncTask } = require("./scripts/sync")
const cron = require("node-cron")

// 引入源配置
const { sources, PRIORITY_LIST } = require("./config/sources")

const app = express()
app.set("trust proxy", 1)
const PORT = process.env.PORT || 3000

// ==========================================
// 0. 核心配置：分类定义与正则
// ==========================================

// 1. 标准分类正则（用于 /api/categories 清洗）
const STANDARD_GROUPS = {
  MOVIE: { id: 1, name: "电影", regex: /电影|片|大片|蓝光|4K|1080P/ },
  TV: { id: 2, name: "剧集", regex: /剧|连续剧|电视|集/ },
  VARIETY: { id: 3, name: "综艺", regex: /综艺|晚会|秀|演唱会|榜/ },
  ANIME: { id: 4, name: "动漫", regex: /动漫|动画|漫/ },
  SPORTS: { id: 5, name: "体育", regex: /体育|球|赛事|NBA|F1/ },
}

// 2. 数据库查询映射（用于 /api/videos 本地查询）
// 作用：前端查 t=1 (电影) 时，数据库实际去查 t=1,6,7,8...
const DB_QUERY_MAPPING = {
  1: [1, 6, 7, 8, 9, 10, 11, 12, 20, 5, 21, 22], // 电影
  2: [2, 13, 14, 15, 16, 23, 24, 25, 30, 31, 32, 37, 44, 45, 46], // 剧集(含短剧)
  3: [3, 25, 26, 27, 28, 29], // 综艺
  4: [4, 29, 30, 31, 32, 33, 34], // 动漫
  5: [5, 36, 38, 39, 40], // 体育
}

// 3. 垃圾分类黑名单
const BLACK_LIST = ["测试", "留言", "公告", "资讯", "全部影片"]

// 4. AI 配置
const AI_API_KEY = process.env.AI_API_KEY
const AI_API_URL = "https://api.siliconflow.cn/v1/chat/completions"

// ==========================================
// 1. 缓存系统 (Redis + 内存降级)
// ==========================================

const localCache = new NodeCache({ stdTTL: 600, checkperiod: 120 })
let redisClient = null

// 🛡️ 增加 try-catch 保护，防止 Redis 连接字符串格式错误导致程序闪退
try {
  if (process.env.REDIS_CONNECTION_STRING) {
    // 打印前几个字符检查是否读取到了变量 (不要打印全部，防止泄露密码)
    console.log(
      "尝试连接 Redis...",
      process.env.REDIS_CONNECTION_STRING.substring(0, 10) + "..."
    )

    redisClient = new Redis(process.env.REDIS_CONNECTION_STRING, {
      // 增加连接重试策略，防止连不上一直卡死或报错
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000)
        return delay
      },
      maxRetriesPerRequest: 3,
    })

    redisClient.on("connect", () => console.log("✅ Redis Cache Connected"))
    redisClient.on("error", (err) => {
      // 只打印错误消息，不中断进程
      console.error("❌ Redis Error (Using Memory Cache):", err.message)
      // 如果连接失败，将 client 置空，后续代码会自动降级到内存缓存
      // redisClient = null; // 可选：如果希望不断重试则不置空
    })
  } else {
    console.log("⚠️ No Redis Config found, using Memory Cache")
  }
} catch (error) {
  console.error("🔥 Redis Init Critical Error:", error.message)
  console.log("⚠️ Falling back to Memory Cache due to Redis config error")
  redisClient = null
}
const getCache = async (key) => {
  try {
    if (redisClient) {
      const data = await redisClient.get(key)
      return data ? JSON.parse(data) : null
    }
    return localCache.get(key)
  } catch (e) {
    return null
  }
}

const setCache = async (key, data, ttlSeconds = 600) => {
  try {
    if (redisClient) {
      await redisClient.set(key, JSON.stringify(data), "EX", ttlSeconds)
    } else {
      localCache.set(key, data, ttlSeconds)
    }
  } catch (e) {
    console.error("Set Cache Error:", e)
  }
}

// ==========================================
// 2. 基础中间件与数据库
// ==========================================

app.use(compression())

// 全局限流
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { code: 429, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
})
app.use("/api/", limiter)

// 🤖 AI 接口限流 (之前遗漏的定义)
const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10, // 每分钟最多10次提问
  message: { code: 429, message: "AI 服务繁忙，请稍后再试" },
})

const corsOptions = {
  origin: process.env.NODE_ENV === "production" ? "*" : "*",
  optionsSuccessStatus: 200,
}
app.use(cors(corsOptions))
app.use(express.json())

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
const User = mongoose.model("User", UserSchema)

// ==========================================
// 3. 智能调度系统 (熔断+竞速)
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
  }
}

const markSourceSuccess = (key) => {
  if (sourceHealth[key].failCount > 0) {
    sourceHealth[key].failCount = 0
    sourceHealth[key].deadUntil = 0
  }
}

const getAxiosConfig = () => {
  const config = { timeout: 6000, httpAgent, httpsAgent }
  if (process.env.PROXY_URL)
    config.httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL)
  return config
}

// 智能请求函数
const smartFetch = async (paramsFn, options = null) => {
  let targetKeys = []
  const specificSourceKey = typeof options === "string" ? options : options?.key
  const scanAll = typeof options === "object" ? options?.scanAll : false

  if (specificSourceKey) {
    targetKeys = [specificSourceKey]
  } else {
    // 取前3个健康的源
    targetKeys = PRIORITY_LIST.filter(
      (key) => sourceHealth[key].deadUntil <= Date.now()
    ).slice(0, 3)
  }

  if (targetKeys.length === 0) targetKeys = [PRIORITY_LIST[0]]

  const requests = targetKeys.map(async (key) => {
    const source = sources[key]
    try {
      const params = paramsFn(source)
      const startTime = Date.now()
      // 设置更短的超时，快速失败
      const response = await axios.get(source.url, {
        params,
        ...getAxiosConfig(),
        timeout: 3000, // 缩短超时时间到3秒
      })

      if (response.data?.list?.length > 0) {
        markSourceSuccess(key)
        return {
          data: response.data,
          sourceName: source.name,
          sourceKey: key,
          duration: Date.now() - startTime,
        }
      }
      throw new Error("Empty Data")
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
// 4. API 路由实现
// ==========================================

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

// 辅助：数据清洗入库
const saveToDB = async (item, sourceKey) => {
  const videoData = {
    id: `${sourceKey}$${item.vod_id}`,
    title: item.vod_name,
    type_id: parseInt(item.type_id) || 0,
    type: item.type_name,
    poster: item.vod_pic,
    remarks: item.vod_remarks,
    year: parseInt(item.vod_year) || 0,
    rating: parseFloat(item.vod_score) || 0,
    date: item.vod_time,
    actors: item.vod_actor || "",
    director: item.vod_director || "",
    overview: (item.vod_content || "")
      .replace(/<[^>]+>/g, "")
      .trim()
      .substring(0, 200),
    vod_play_from: item.vod_play_from,
    vod_play_url: item.vod_play_url,
    updatedAt: new Date(),
  }
  // 异步更新，不阻塞
  Video.updateOne(
    { id: videoData.id },
    { $set: videoData },
    { upsert: true }
  ).catch((e) => {})
  return videoData
}

// [接口 1] 列表与搜索：本地优先 + 自动互补 + 智能修正
app.get("/api/videos", async (req, res) => {
  const { t, pg = 1, wd, h, year } = req.query
  const page = parseInt(pg)
  const limit = 20
  const skip = (page - 1) * limit

  try {
    // 1. 构建本地查询条件
    const query = {}
    if (wd) {
      const regex = new RegExp(wd, "i")
      query.$or = [{ title: regex }, { actors: regex }, { director: regex }]
    }

    // 🔥 DB 映射：查父类时自动查库里的子类
    if (t) {
      const typeId = parseInt(t)
      if (DB_QUERY_MAPPING[typeId]) {
        query.type_id = { $in: DB_QUERY_MAPPING[typeId] }
      } else {
        query.type_id = typeId
      }
    }

    if (year && year !== "全部") {
      query.year = parseInt(year)
    }

    // 执行本地查询
    const [localList, localTotal] = await Promise.all([
      Video.find(query)
        .select("id title poster type year rating remarks type_id")
        .sort({ date: -1, year: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Video.countDocuments(query),
    ])

    // 2. 决策：是否回源
    // 条件：搜索结果过少 OR 分类结果完全没有
    const needRemote =
      (wd && localList.length < 5) || (!wd && localList.length === 0)

    if (page === 1 && needRemote) {
      console.log(`[Hybrid] 本地不足 (t=${t}, wd=${wd}), 触发回源...`)

      const paramsFn = (source) => {
        const p = { ac: "detail", at: "json", pg: 1 }
        if (wd) p.wd = wd

        // 🔥 远程映射：查父类时自动转查热门子类 (解决 t=1 无数据)
        if (t) {
          let reqId = parseInt(t)
          if (source.id_map && source.id_map[reqId])
            reqId = source.id_map[reqId]

          // 强制修正：父类 -> 热门子类
          if (reqId === 1) reqId = 6 // 电影 -> 动作
          if (reqId === 2) reqId = 13 // 剧集 -> 国产
          p.t = reqId
        }
        if (year && year !== "全部") p.year = year
        return p
      }

      try {
        const remoteResult = await smartFetch(
          paramsFn,
          wd ? { scanAll: true } : null
        )
        const remoteList = remoteResult.data.list

        // 远程数据入库并去重
        const processedRemote = []
        for (const item of remoteList) {
          const savedItem = await saveToDB(item, remoteResult.sourceKey)
          if (!localList.some((l) => l.title === savedItem.title)) {
            processedRemote.push(savedItem)
          }
        }

        const finalList = [...localList, ...processedRemote]
        const finalTotal = localTotal + (remoteResult.data.total || 0)

        return success(res, {
          list: finalList,
          total: finalTotal > 0 ? finalTotal : finalList.length,
          page: page,
          pagecount: Math.ceil(finalTotal / limit),
          source: `Hybrid (Local + ${remoteResult.sourceName})`,
        })
      } catch (err) {
        console.warn("[Hybrid] 远程回源失败:", err.message)
      }
    }

    // 3. 返回结果
    success(res, {
      list: localList,
      total: localTotal,
      page: page,
      pagecount: Math.ceil(localTotal / limit) || 1,
      source: "Local Database",
    })
  } catch (e) {
    console.error("API Videos Error:", e)
    fail(res, "查询失败")
  }
})

// v2. 筛选页接口 (Filter)
// 前端调用: /api/v2/videos?cat=tv&tag=悬疑&area=韩国&sort=rating
app.get("/api/v2/videos", async (req, res) => {
  try {
    const { cat, tag, area, year, sort, pg = 1 } = req.query
    const limit = 20
    const skip = (pg - 1) * limit

    const query = {}
    if (cat) query.category = cat // movie, tv, anime...

    // 标签筛选 (支持多个)
    if (tag) {
      // 如果传了 "悬疑", MongoDB 会自动在 tags 数组里找
      query.tags = tag
    }

    if (area) query.area = new RegExp(area)
    if (year) query.year = parseInt(year)

    // 排序逻辑
    let sortObj = { updatedAt: -1 } // 默认按更新时间
    if (sort === "rating") sortObj = { rating: -1 }
    if (sort === "year") sortObj = { year: -1 }

    const list = await Video.find(query)
      .sort(sortObj)
      .skip(skip)
      .limit(limit)
      .select("title poster remarks rating year tags")

    res.json({ code: 200, list })
  } catch (e) {
    res.status(500).json({ code: 500, msg: "Error" })
  }
})

// [接口 2] 首页 Trending (修复版：带容错保护)
app.get("/api/home/trending", async (req, res) => {
  const cacheKey = "home_dashboard_v11_safe"
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    // 🛡️ 定义安全的 fetch，失败不抛错，只返回 null
    const safeFetch = async (paramsFn, options) => {
      try {
        const res = await smartFetch(paramsFn, options)
        return res
      } catch (e) {
        console.warn(`[Trending] Partial Fetch failed:`, e.message)
        return null
      }
    }

    const fetchByMap = (mapKey) =>
      safeFetch((s) => ({
        ac: "detail",
        at: "json",
        pg: 1,
        t: s.home_map[mapKey],
      }))

    const fetchByStdId = (id) =>
      safeFetch((s) => ({
        ac: "detail",
        at: "json",
        pg: 1,
        t: s.id_map && s.id_map[id] ? s.id_map[id] : id,
      }))

    // 并行请求，使用 safeFetch 确保某一个失败不影响整体
    const [bannerRes, movieRes, tvRes, animeRes, varietyRes, sportsRes] =
      await Promise.all([
        safeFetch(() => ({ ac: "detail", at: "json", pg: 1, h: 24 })), // 0. Banner
        fetchByMap("movie_hot"), // 1. 电影
        fetchByMap("tv_cn"), // 2. 剧集
        fetchByMap("anime"), // 3. 动漫
        fetchByStdId(3), // 4. 综艺
        safeFetch(() => ({ ac: "detail", at: "json", pg: 1, wd: "NBA" }), {
          scanAll: true,
        }), // 5. 体育
      ])

    const process = (result, limit = 12) => {
      if (!result || !result.data || !result.data.list) return []
      // 数据清洗 + 自动入库
      const list = result.data.list.map((item) => {
        saveToDB(item, result.sourceKey)
        return {
          id: `${result.sourceKey}$${item.vod_id}`,
          title: item.vod_name,
          type: item.type_name,
          poster: item.vod_pic,
          remarks: item.vod_remarks,
          year: parseInt(item.vod_year) || 0,
          rating: parseFloat(item.vod_score) || 0.0,
        }
      })
      return list.slice(0, limit)
    }

    const data = {
      banners: process(bannerRes, 5),
      movies: process(movieRes, 12),
      tvs: process(tvRes, 12),
      animes: process(animeRes, 12),
      varieties: process(varietyRes, 12),
      sports: process(sportsRes, 12),
    }

    // 只有当核心数据不为空时才缓存
    if (data.movies.length > 0 || data.tvs.length > 0) {
      await setCache(cacheKey, data, 1800)
    }

    success(res, data)
  } catch (e) {
    console.error("Trending Fatal Error:", e)
    // 即使全挂了，返回空结构，避免前端白屏
    success(res, {
      banners: [],
      movies: [],
      tvs: [],
      animes: [],
      varieties: [],
      sports: [],
    })
  }
})

// v2. 首页“精装修”接口 (对应你截图的布局)
app.get("/api/v2/home", async (req, res) => {
  try {
    // 并行查询，速度极快
    const [banners, netflix, shortDrama, highRateTv, newMovies] =
      await Promise.all([
        // 轮播图：取最近更新的 4K 电影或 Netflix 剧集
        Video.find({ tags: { $in: ["netflix", "4k"] }, category: "movie" })
          .sort({ updatedAt: -1 })
          .limit(5)
          .select("title poster tags remarks id"),

        // Section 1: Netflix 独家 (剧集)
        Video.find({ tags: "netflix", category: "tv" })
          .sort({ updatedAt: -1 })
          .limit(10)
          .select("title poster remarks"),

        // Section 2: 热门短剧 (专门筛选 miniseries 标签)
        Video.find({ tags: "miniseries" })
          .sort({ updatedAt: -1 })
          .limit(10)
          .select("title poster remarks"),

        // Section 3: 高分美剧 (分类+标签+评分排序)
        Video.find({ tags: "欧美", category: "tv", rating: { $gt: 0 } })
          .sort({ rating: -1 })
          .limit(10)
          .select("title poster rating"),

        // Section 4: 院线新片
        Video.find({ category: "movie", tags: "new_arrival" })
          .sort({ updatedAt: -1 })
          .limit(12)
          .select("title poster remarks"),
      ])

    res.json({
      code: 200,
      data: {
        banners,
        sections: [
          { title: "Netflix 精选", type: "scroll", data: netflix },
          { title: "爆火短剧", type: "grid", data: shortDrama },
          { title: "口碑美剧", type: "grid", data: highRateTv },
          { title: "院线新片", type: "grid", data: newMovies },
        ],
      },
    })
  } catch (e) {
    res.status(500).json({ code: 500, msg: e.message })
  }
})

// [接口 3] 分类列表 (自动正则清洗)
app.get("/api/categories", async (req, res) => {
  const cacheKey = "categories_auto_washed_v2"
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    const result = await smartFetch(() => ({ ac: "list", at: "json" }))
    if (!result || !result.data || !result.data.class)
      throw new Error("No data")

    const rawList = result.data.class

    // 预设父类
    const washedList = [
      { type_id: 1, type_pid: 0, type_name: "电影" },
      { type_id: 2, type_pid: 0, type_name: "剧集" },
      { type_id: 3, type_pid: 0, type_name: "综艺" },
      { type_id: 4, type_pid: 0, type_name: "动漫" },
      { type_id: 5, type_pid: 0, type_name: "体育" },
    ]

    rawList.forEach((item) => {
      const name = item.type_name
      const id = parseInt(item.type_id)

      if (BLACK_LIST.some((bad) => name.includes(bad))) return
      if (["电影", "电视剧", "连续剧", "综艺", "动漫", "体育"].includes(name))
        return

      let targetPid = 0

      // 正则匹配名字
      if (STANDARD_GROUPS.SPORTS.regex.test(name)) targetPid = 5
      else if (STANDARD_GROUPS.ANIME.regex.test(name)) targetPid = 4
      else if (STANDARD_GROUPS.VARIETY.regex.test(name)) targetPid = 3
      else if (STANDARD_GROUPS.TV.regex.test(name)) targetPid = 2
      else if (STANDARD_GROUPS.MOVIE.regex.test(name)) targetPid = 1

      // 兜底：根据 ID 范围猜测
      if (targetPid === 0) {
        if (id >= 6 && id <= 12) targetPid = 1
        else if (id >= 13 && id <= 24) targetPid = 2
        else if (id >= 25 && id <= 29) targetPid = 3
        else if (id >= 30 && id <= 34) targetPid = 4
        else targetPid = 999
      }

      washedList.push({ type_id: id, type_name: name, type_pid: targetPid })
    })

    await setCache(cacheKey, washedList, 86400)
    success(res, washedList)
  } catch (e) {
    success(res, [
      { type_id: 1, type_pid: 0, type_name: "电影" },
      { type_id: 2, type_pid: 0, type_name: "剧集" },
      { type_id: 3, type_pid: 0, type_name: "综艺" },
      { type_id: 4, type_pid: 0, type_name: "动漫" },
    ])
  }
})

// [接口 4] 详情 (每次必回源 + 更新数据库)
app.get("/api/detail/:id", async (req, res) => {
  const { id } = req.params
  // 1️⃣ 先查缓存 (缓存 10 分钟)
  const cacheKey = `detail_${id}`
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)
  const parseEpisodes = (urlStr, fromStr) => {
    if (!urlStr) return []
    const froms = (fromStr || "").split("$$$")
    const urls = urlStr.split("$$$")
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

  let sourceKey = PRIORITY_LIST[0]
  let vodId = id
  if (id.includes("$")) {
    const parts = id.split("$")
    sourceKey = parts[0]
    vodId = parts[1]
  }

  try {
    const result = await smartFetch(
      () => ({ ac: "detail", at: "json", ids: vodId }),
      sourceKey
    )

    if (
      !result ||
      !result.data ||
      !result.data.list ||
      result.data.list.length === 0
    ) {
      return fail(res, "资源不存在", 404)
    }

    const detail = result.data.list[0]
    const savedData = await saveToDB(detail, sourceKey)
    const responseData = {
      ...savedData,
      area: detail.vod_area,
      episodes: parseEpisodes(detail.vod_play_url, detail.vod_play_from),
      source: result.sourceName,
      latency: result.duration,
    }

    // 2️⃣ 写入缓存
    await setCache(cacheKey, responseData, 600)

    success(res, responseData)
  } catch (e) {
    console.error("Detail Error:", e.message)
    fail(res, "获取详情失败")
  }
})

// [接口 5] AI 搜索
app.post("/api/ai/ask", aiLimiter, async (req, res) => {
  const { question } = req.body
  if (!AI_API_KEY) return fail(res, "AI Key Missing", 500)

  try {
    const response = await axios.post(
      AI_API_URL,
      {
        model: "deepseek-ai/DeepSeek-V3",
        messages: [
          {
            role: "system",
            content:
              "你是一个影视搜索助手。请直接推荐3-5个相关的国内上映的影片中文名称，用逗号分隔，不要有任何多余文字。",
          },
          { role: "user", content: question },
        ],
        stream: false,
        max_tokens: 100,
      },
      { headers: { Authorization: `Bearer ${AI_API_KEY}` } }
    )
    const content = response.data.choices[0].message.content
    const list = content
      .replace(/[。.!！《》\n]/g, "")
      .split(/,|，/)
      .map((s) => s.trim())
      .filter((s) => s)
    success(res, list)
  } catch (error) {
    success(res, ["庆余年2", "抓娃娃", "热辣滚烫"])
  }
})

// [接口 6] 用户系统补全
// 注册
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body
  try {
    const existing = await User.findOne({ username })
    if (existing) return fail(res, "用户已存在", 400)
    const newUser = new User({ username, password }) // 生产环境请加密密码
    await newUser.save()
    success(res, { id: newUser._id, username })
  } catch (e) {
    fail(res, "注册失败")
  }
})

// 登录
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body
  try {
    const user = await User.findOne({ username, password })
    if (!user) return fail(res, "账号或密码错误", 401)
    success(res, { id: user._id, username: user.username })
  } catch (e) {
    fail(res, "登录失败")
  }
})

// 获取历史
app.get("/api/user/history", async (req, res) => {
  const { username } = req.query
  if (!username) return success(res, [])
  try {
    const user = await User.findOne({ username })
    if (!user) return success(res, [])
    const validHistory = (user.history || []).filter(
      (item) => item && item.id && item.title
    )
    success(res, validHistory)
  } catch (e) {
    success(res, [])
  }
})

// 添加历史
app.post("/api/user/history", async (req, res) => {
  const { username, video, episodeIndex, progress } = req.body
  if (!username || !video || !video.id) return fail(res, "参数错误", 400)
  try {
    const user = await User.findOne({ username })
    if (!user) return fail(res, "用户不存在", 404)

    const targetId = String(video.id)
    const rawId = targetId.includes("$") ? targetId.split("$")[1] : targetId

    let newHistory = (user.history || []).filter((h) => {
      const hId = String(h.id)
      const hRawId = hId.includes("$") ? hId.split("$")[1] : hId
      return hId !== targetId && hRawId !== rawId
    })

    const historyItem = {
      ...video,
      id: targetId,
      episodeIndex: parseInt(episodeIndex) || 0,
      progress: parseFloat(progress) || 0,
      viewedAt: new Date().toISOString(),
    }

    newHistory.unshift(historyItem)
    user.history = newHistory.slice(0, 50)
    user.markModified("history")
    await user.save()
    success(res, user.history)
  } catch (e) {
    fail(res, "保存失败")
  }
})

// 清空历史
app.delete("/api/user/history", async (req, res) => {
  const { username } = req.query
  try {
    const user = await User.findOne({ username })
    if (user) {
      user.history = []
      user.markModified("history")
      await user.save()
    }
    success(res, [])
  } catch (e) {
    fail(res, "清空失败")
  }
})

// 启动采集任务
// const runSyncTask = () => {
//   console.log(`📅 [Sync] 触发全量采集...`)
//   const syncProcess = exec("node scripts/sync.js")
//   syncProcess.stdout.on("data", (d) => console.log(`[Sync] ${d.trim()}`))
// }

// if (process.env.NODE_ENV === "production") {
//   setTimeout(runSyncTask, 5000)
// }
cron.schedule("0 */2 * * *", () => {
  syncTask(3) // 采集最近3小时的变动
})
// 错误处理
app.use((err, req, res, next) => {
  console.error("Global Error:", err)
  res.status(500).json({ code: 500, message: "Server Internal Error" })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Server running on port ${PORT}`)
})
