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

app.get("/api/user/history", async (req, res) => {
  const { username } = req.query
  if (!username) return success(res, [])
  try {
    const user = await User.findOne({ username })
    success(res, user ? user.history : [])
  } catch (e) {
    success(res, [])
  }
})

app.post("/api/user/history", async (req, res) => {
  const { username, video, episodeIndex, progress } = req.body
  if (!username || !video) return fail(res, "参数错误", 400)
  try {
    const user = await User.findOne({ username })
    if (!user) return fail(res, "用户不存在", 404)
    const targetId = String(video.id)
    const historyItem = {
      ...video,
      id: targetId,
      episodeIndex: parseInt(episodeIndex) || 0,
      progress: parseFloat(progress) || 0,
      viewedAt: new Date().toISOString(),
    }
    let newHistory = (user.history || []).filter(
      (h) => String(h.id) !== targetId
    )
    newHistory.unshift(historyItem)
    user.history = newHistory.slice(0, 50)
    user.markModified("history")
    await user.save()
    success(res, user.history)
  } catch (e) {
    fail(res, "保存失败")
  }
})

const AI_API_KEY = process.env.AI_API_KEY
const AI_API_URL = "https://api.siliconflow.cn/v1/chat/completions"

app.post("/api/ai/ask", aiLimiter, async (req, res) => {
  const { question } = req.body
  if (!AI_API_KEY) return fail(res, "服务端未配置 AI Key", 500)
  if (!question) return fail(res, "请输入问题", 400)
  try {
    const response = await axios.post(
      AI_API_URL,
      {
        model: "Qwen/Qwen2.5-7B-Instruct",
        messages: [
          {
            role: "system",
            content:
              "你是一个影视百科专家。请根据用户描述推测影视作品。直接返回 3-6 个最可能的名称，用英文逗号分隔。",
          },
          { role: "user", content: question },
        ],
        stream: false,
        max_tokens: 100,
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${AI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    )
    const content = response.data.choices[0].message.content
    const recommendations = content
      .replace(/。/g, "")
      .split(/,|，|\n/)
      .map((s) => s.trim())
      .filter((s) => s)
    success(res, recommendations)
  } catch (error) {
    fail(res, "AI 暂时繁忙")
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
