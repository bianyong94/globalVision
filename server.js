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

const smartFetch = async (paramsFn, specificSourceKey = null) => {
  let targetKeys = []

  if (specificSourceKey) {
    targetKeys = [specificSourceKey]
  } else {
    targetKeys = PRIORITY_LIST.filter(
      (key) => sourceHealth[key].deadUntil <= Date.now()
    ).slice(0, 3)
  }

  if (targetKeys.length === 0) targetKeys = [PRIORITY_LIST[0]]

  const requests = targetKeys.map(async (key) => {
    const source = sources[key]
    if (!source) throw new Error("Config missing")

    try {
      const params = paramsFn(source)
      const response = await axios.get(source.url, {
        params,
        ...getAxiosConfig(),
      })

      if (
        response.data &&
        response.data.list &&
        response.data.list.length > 0
      ) {
        markSourceSuccess(key)
        return {
          data: response.data,
          sourceName: source.name,
          sourceKey: key,
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
    throw new Error("所有线路繁忙")
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

// [首页] - 使用 Redis 缓存
app.get("/api/home/trending", async (req, res) => {
  const cacheKey = "home_dashboard_v5" // 缓存 Key

  // ✨ 1. 尝试从缓存取
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    const createFetcher = (typeFunc) =>
      smartFetch((s) => ({ ac: "detail", at: "json", pg: 1, ...typeFunc(s) }))

    const taskLatest = smartFetch(() => ({ ac: "detail", at: "json", pg: 1 }))
    const taskMovies = createFetcher((s) => ({ t: s.home_map.movie_hot }))
    const taskTvs = createFetcher((s) => ({ t: s.home_map.tv_cn }))
    const taskAnimes = createFetcher((s) => ({ t: s.home_map.anime }))

    const results = await Promise.allSettled([
      taskLatest,
      taskMovies,
      taskTvs,
      taskAnimes,
    ])

    const logStatus = (name, result) => {
      if (result.status === "rejected") {
        console.warn(`⚠️ [首页] ${name} 失败:`, result.reason.message)
        return []
      }
      const list = result.value.data.list
      if (!list || list.length === 0) return []
      return processVideoList(list, result.value.sourceKey, 12)
    }

    const data = {
      banners: processVideoList(
        results[0].status === "fulfilled" ? results[0].value.data.list : [],
        results[0].status === "fulfilled" ? results[0].value.sourceKey : null,
        5
      ),
      movies: logStatus("电影", results[1]),
      tvs: logStatus("剧集", results[2]),
      animes: logStatus("动漫", results[3]),
    }

    // ✨ 2. 存入缓存 (10分钟)
    await setCache(cacheKey, data, 600)

    success(res, data)
  } catch (e) {
    console.error("Home Error:", e)
    fail(res, "首页服务繁忙")
  }
})

// [搜索]
app.get("/api/videos", async (req, res) => {
  const { t, pg, wd, h, year, by } = req.query

  try {
    const result = await smartFetch((source) => {
      const params = { ac: "detail", at: "json", pg: pg || 1 }
      if (t) params.t = source.id_map && source.id_map[t] ? source.id_map[t] : t
      if (wd) params.wd = wd
      if (h) params.h = h
      return params
    })

    let list = processVideoList(result.data.list, result.sourceKey, 100)
    if (year && year !== "全部") {
      list = list.filter((v) => v.year == year)
    }
    if (by === "score") list.sort((a, b) => b.rating - a.rating)

    success(res, {
      list,
      total: result.data.total,
      source: result.sourceName,
    })
  } catch (e) {
    success(res, { list: [] })
  }
})

// [详情]
app.get("/api/detail/:id", async (req, res) => {
  const { id } = req.params
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

    const detail = result.data.list[0]
    const parseEpisodes = (urlStr, fromStr) => {
      if (!urlStr) return []
      const froms = (fromStr || "").split("$$$")
      const urls = urlStr.split("$$$")
      let idx = froms.findIndex((f) => f.toLowerCase().includes("m3u8"))
      if (idx === -1) idx = 0
      const targetUrl = urls[idx] || urls[0]
      return targetUrl.split("#").map((ep) => {
        const [name, link] = ep.split("$")
        return { name: link ? name : "正片", link: link || name }
      })
    }

    success(res, {
      id: `${sourceKey}$${detail.vod_id}`,
      title: detail.vod_name,
      overview: (detail.vod_content || "").replace(/<[^>]+>/g, "").trim(),
      poster: detail.vod_pic,
      type: detail.type_name,
      area: detail.vod_area,
      year: detail.vod_year,
      director: detail.vod_director,
      actors: detail.vod_actor,
      remarks: detail.vod_remarks,
      rating: detail.vod_score,
      episodes: parseEpisodes(detail.vod_play_url, detail.vod_play_from),
    })
  } catch (e) {
    fail(res, "资源未找到")
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

// [History] 保存/更新历史记录 (增强健壮性版)
app.post("/api/user/history", async (req, res) => {
  const { username, video, episodeIndex, progress } = req.body

  // 1. 基础校验
  if (!username || !video || !video.id) {
    return fail(res, "参数缺失", 400)
  }

  try {
    const user = await User.findOne({ username })
    if (!user) return fail(res, "用户不存在", 404)

    // 2. 统一 ID 格式 (转为字符串，防止 Int/String 混用导致匹配失败)
    const targetId = String(video.id)

    // 3. 构建新记录对象
    const historyItem = {
      id: targetId,
      title: video.title || "未知视频",
      poster: video.poster || "",
      type: video.type || "其他",
      // 确保进度是数字
      episodeIndex: Number(episodeIndex) || 0,
      progress: Number(progress) || 0,
      viewedAt: new Date().toISOString(),
    }

    // 4. 核心去重逻辑：移除旧的同名记录 (无论 ID 是 '123' 还是 'sony$123')
    // 如果你想更严格，可以只按 ID 去重。但考虑到你换了 ID 格式，
    // 为了防止出现两条《复仇者联盟》(一条旧ID，一条新ID)，我们可以加一个 Title 辅助判断（可选）

    let currentHistory = user.history || []

    // 过滤掉：1. ID 相同的; 2. (可选) 标题相同且 ID 格式不兼容的脏数据
    currentHistory = currentHistory.filter((h) => {
      const hId = String(h.id)
      // 如果 ID 完全相等，删掉
      if (hId === targetId) return false
      return true
    })

    // 5. 插入头部
    currentHistory.unshift(historyItem)

    // 6. 限制最大条数 (50条)，防止数据库膨胀
    if (currentHistory.length > 50) {
      currentHistory = currentHistory.slice(0, 50)
    }

    // 7. 保存
    user.history = currentHistory
    user.markModified("history") // 关键：告诉 Mongoose 混合类型已修改
    await user.save()
    console.log("History Saved:", username)
    success(res, user.history)
  } catch (e) {
    console.error("History Save Error:", e)
    fail(res, "保存失败")
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

app.use((err, req, res, next) => {
  console.error("Global Error:", err)
  res.status(500).json({ code: 500, message: "Server Internal Error" })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Server running on port ${PORT}`)
  console.log(`🛡️  Mode: Production | RateLimit: ON | Redis: Supported`)
})
