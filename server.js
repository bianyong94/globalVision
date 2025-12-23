// server.js - 终极版 (并发竞速 + 熔断 + 演员搜索支持)
require("dotenv").config()
const express = require("express")
const axios = require("axios")
const cors = require("cors")
const NodeCache = require("node-cache")
const mongoose = require("mongoose")
const http = require("http")
const https = require("https")
const { HttpsProxyAgent } = require("https-proxy-agent")

// 引入源配置
const { sources, PRIORITY_LIST } = require("./config/sources")

const app = express()
const PORT = process.env.PORT || 3000
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 })

// ==========================================
// 1. 基础设施 (HTTP代理/连接池/数据库)
// ==========================================

// 启用 Keep-Alive 复用连接，显著减少 SSL 握手延迟
const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
})

// MongoDB 连接
const MONGO_URI = process.env.MONGO_URI
if (MONGO_URI) {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.error("❌ MongoDB Connection Error:", err))
}

// User 模型
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  history: { type: Array, default: [] },
  createdAt: { type: Date, default: Date.now },
})
const User = mongoose.model("User", UserSchema)

app.use(cors())
app.use(express.json())

// ==========================================
// 2. 智能调度核心 (熔断与并发)
// ==========================================

// 熔断状态存储
const sourceHealth = {}
PRIORITY_LIST.forEach((key) => {
  sourceHealth[key] = { failCount: 0, deadUntil: 0 }
})

const markSourceFailed = (key) => {
  const health = sourceHealth[key]
  health.failCount++
  if (health.failCount >= 3) {
    health.deadUntil = Date.now() + 5 * 60 * 1000 // 3次失败 -> 封禁5分钟
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

// 获取请求配置
const getAxiosConfig = () => {
  const config = {
    timeout: 5000, // 5秒超时
    httpAgent,
    httpsAgent,
    proxy: false,
  }
  if (process.env.PROXY_URL)
    config.httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL)
  return config
}

/**
 * 🚀 智能并发请求
 * 同时请求多个健康的源，谁先回来用谁的数据 (Promise.any)
 */
const smartFetch = async (paramsFn, specificSourceKey = null) => {
  let targetKeys = []

  if (specificSourceKey) {
    targetKeys = [specificSourceKey] // 详情页指定源
  } else {
    // 列表页：过滤掉熔断的源，取前3个健康源竞速
    targetKeys = PRIORITY_LIST.filter(
      (key) => sourceHealth[key].deadUntil <= Date.now()
    ).slice(0, 3)
  }

  if (targetKeys.length === 0) targetKeys = [PRIORITY_LIST[0]] // 兜底

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
// 3. 数据清洗 (包含演员字段支持)
// ==========================================

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

const processVideoList = (list, sourceKey, limit = 12) => {
  if (!list || !Array.isArray(list)) return []

  const processed = list.map((item) => ({
    id: `${sourceKey}$${item.vod_id}`, // ID 绑定源
    title: item.vod_name,
    type: item.type_name,
    poster: item.vod_pic,
    remarks: item.vod_remarks,
    year: parseInt(item.vod_year) || 0,
    rating: parseFloat(item.vod_score) || 0.0,
    date: item.vod_time,

    // ✨ 新增：支持演员和导演搜索展示
    // 前端 VideoCard 可以显示 "主演: xxx"
    actors: item.vod_actor || "",
    director: item.vod_director || "",
  }))

  // 排序：优先年份新 > 评分高
  processed.sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year
    return b.rating - a.rating
  })

  return limit ? processed.slice(0, limit) : processed
}

// ==========================================
// 4. API 路由
// ==========================================

// [首页聚合]
app.get("/api/home/trending", async (req, res) => {
  const cacheKey = "home_dashboard_v2"
  if (cache.has(cacheKey)) return success(res, cache.get(cacheKey))

  try {
    const createFetcher = (typeFunc) =>
      smartFetch((s) => ({
        ac: "detail",
        at: "json",
        pg: 1,
        ...typeFunc(s),
      }))

    // 并发获取四大板块
    const [latest, movies, tvs, animes] = await Promise.allSettled([
      smartFetch(() => ({ ac: "detail", at: "json", pg: 1, h: 24 })),
      createFetcher((s) => ({ t: s.home_map.movie_hot })),
      createFetcher((s) => ({ t: s.home_map.tv_cn })),
      createFetcher((s) => ({ t: s.home_map.anime })),
    ])

    const extract = (r, limit) =>
      r.status === "fulfilled"
        ? processVideoList(r.value.data.list, r.value.sourceKey, limit)
        : []

    const data = {
      banners: extract(latest, 5),
      movies: extract(movies, 12),
      tvs: extract(tvs, 12),
      animes: extract(animes, 12),
    }

    cache.set(cacheKey, data)
    success(res, data)
  } catch (e) {
    console.error(e)
    fail(res, "首页服务繁忙")
  }
})

// [搜索/列表]
app.get("/api/videos", async (req, res) => {
  const { t, pg, wd, h, year, by } = req.query

  try {
    const result = await smartFetch((source) => {
      // ⚠️ 关键：wd (keywords) 会被标准 CMS 接口用于匹配 标题、演员、导演
      const params = { ac: "detail", at: "json", pg: pg || 1 }

      if (t) params.t = source.id_map && source.id_map[t] ? source.id_map[t] : t
      if (wd) params.wd = wd
      if (h) params.h = h

      return params
    })

    let list = processVideoList(result.data.list, result.sourceKey, 100)

    // 二次过滤 (有些源接口不支持年份筛选，需手动过滤)
    if (year && year !== "全部") {
      list = list.filter((v) => v.year == year)
    }

    success(res, {
      list,
      total: result.data.total,
      source: result.sourceName,
    })
  } catch (e) {
    success(res, { list: [] }) // 搜不到返回空，不报错
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
      () => ({
        ac: "detail",
        at: "json",
        ids: vodId,
      }),
      sourceKey
    )

    const detail = result.data.list[0]

    // 播放地址解析
    const parseEpisodes = (urlStr, fromStr) => {
      if (!urlStr) return []
      const froms = (fromStr || "").split("$$$")
      const urls = urlStr.split("$$$")
      // 优先 m3u8
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
      actors: detail.vod_actor, // 详情页当然也要有演员
      remarks: detail.vod_remarks,
      rating: detail.vod_score,
      episodes: parseEpisodes(detail.vod_play_url, detail.vod_play_from),
    })
  } catch (e) {
    fail(res, "资源未找到")
  }
})

// [分类]
app.get("/api/categories", async (req, res) => {
  const cacheKey = "categories"
  if (cache.has(cacheKey)) return success(res, cache.get(cacheKey))
  try {
    const result = await smartFetch(() => ({ ac: "list", at: "json" }))
    const rawClass = result.data.class || []
    const safeClass = rawClass.filter(
      (c) => !["伦理", "福利"].includes(c.type_name)
    )
    cache.set(cacheKey, safeClass, 86400)
    success(res, safeClass)
  } catch (e) {
    success(res, [])
  }
})

// [Auth] 保持不变...
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
  try {
    const user = await User.findOne({ username })
    success(res, user ? user.history : [])
  } catch (e) {
    success(res, [])
  }
})

app.post("/api/user/history", async (req, res) => {
  const { username, video } = req.body
  if (!username || !video) return fail(res, "参数错误", 400)
  try {
    const user = await User.findOne({ username })
    if (!user) return fail(res, "用户不存在", 404)
    let newHistory = (user.history || []).filter(
      (h) => String(h.id) !== String(video.id)
    )
    newHistory.unshift({ ...video, viewedAt: new Date() })
    user.history = newHistory.slice(0, 50)
    user.markModified("history")
    await user.save()
    success(res, "ok")
  } catch (e) {
    fail(res, "保存失败")
  }
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Server running on port ${PORT}`)
  console.log(`🛡️  Features: Concurrency / CircuitBreaker / ActorSearch`)
})
