const { HttpsProxyAgent } = require("https-proxy-agent")
require("dotenv").config()
const express = require("express")
const axios = require("axios")
const cors = require("cors")
const NodeCache = require("node-cache")
const mongoose = require("mongoose") // 引入 mongoose

// 引入源配置
const { sources, PRIORITY_LIST } = require("./config/sources")

const app = express()
const PORT = process.env.PORT || 3000
const cache = new NodeCache({ stdTTL: 600 }) // 缓存10分钟

// ⚠️ 请确保在 .env 文件中配置了 MONGO_URI
// 格式: mongodb+srv://用户名:密码@cluster0.xxx.mongodb.net/movie_app?retryWrites=true&w=majority
const MONGO_URI = process.env.MONGO_URI

// 连接 MongoDB
if (MONGO_URI) {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.error("❌ MongoDB Connection Error:", err))
} else {
  console.error("❌ 警告: 未配置 MONGO_URI，数据库功能将无法使用！")
}

// 定义用户模型
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
// 1. 智能请求核心 (轮询机制 - 保持不变)
// ==========================================

// 代理生成
const getProxyAgent = () => {
  if (process.env.PROXY_URL) return new HttpsProxyAgent(process.env.PROXY_URL)
  if (process.env.NODE_ENV !== "production")
    return new HttpsProxyAgent("http://127.0.0.1:7897")
  return null
}

// 核心：多源轮询请求器
const multiSourceFetch = async (endpointParamsFn) => {
  const agent = getProxyAgent()
  let lastError = null

  for (const sourceKey of PRIORITY_LIST) {
    const source = sources[sourceKey]
    if (!source) continue

    try {
      const params = endpointParamsFn(source)

      const response = await axios.get(source.url, {
        params,
        timeout: 4000, // 4秒超时，快速切换
        httpsAgent: agent,
        proxy: false,
      })

      if (
        response.data &&
        response.data.list &&
        response.data.list.length > 0
      ) {
        // console.log(`✅ [Success] Source: ${source.name}`)
        return { data: response.data, sourceName: source.name }
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error("All sources failed")
}

// ==========================================
// 2. 数据处理工具 (保持不变)
// ==========================================
const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.status(code).json({ code, message: msg })

const processVideoList = (list, limit = 12) => {
  if (!list || !Array.isArray(list)) return []
  const currentYear = new Date().getFullYear()

  const processed = list.map((item) => ({
    id: item.vod_id,
    title: item.vod_name,
    type: item.type_name,
    poster: item.vod_pic,
    backdrop: item.vod_pic,
    remarks: item.vod_remarks,
    year: parseInt(item.vod_year) || 0,
    rating: parseFloat(item.vod_score) || 0.0,
    date: item.vod_time,
  }))

  processed.sort((a, b) => {
    if (a.year !== b.year) return b.year - a.year
    if (a.rating !== b.rating) return b.rating - a.rating
    return 0
  })

  let final = processed.filter((item) => item.year >= currentYear - 1)
  if (final.length < 4) final = processed

  return final.slice(0, limit)
}

// ==========================================
// 3. 业务接口 (保持不变)
// ==========================================

// [业务] 首页聚合
app.get("/api/home/trending", async (req, res) => {
  const cacheKey = "home_dashboard_mongo_v1"
  if (cache.has(cacheKey)) return success(res, cache.get(cacheKey))

  try {
    const taskLatest = multiSourceFetch((source) => ({
      ac: "detail",
      at: "json",
      pg: 1,
      h: 24,
    }))
    const taskMovies = multiSourceFetch((source) => ({
      ac: "detail",
      at: "json",
      pg: 1,
      t: source.home_map.movie_hot,
    }))
    const taskTvs = multiSourceFetch((source) => ({
      ac: "detail",
      at: "json",
      pg: 1,
      t: source.home_map.tv_cn,
    }))
    const taskAnimes = multiSourceFetch((source) => ({
      ac: "detail",
      at: "json",
      pg: 1,
      t: source.home_map.anime,
    }))

    const results = await Promise.allSettled([
      taskLatest,
      taskMovies,
      taskTvs,
      taskAnimes,
    ])

    const getList = (result) =>
      result.status === "fulfilled" ? result.value.data.list : []

    const data = {
      banners: processVideoList(getList(results[0]), 5),
      movies: processVideoList(getList(results[1]), 12),
      tvs: processVideoList(getList(results[2]), 12),
      animes: processVideoList(getList(results[3]), 12),
    }

    cache.set(cacheKey, data)
    success(res, data)
  } catch (error) {
    console.error("Home Fatal:", error)
    fail(res, "首页服务暂不可用")
  }
})

// [业务] 通用列表
app.get("/api/videos", async (req, res) => {
  const { t, pg, wd, h, year } = req.query

  try {
    const result = await multiSourceFetch((source) => {
      const params = { ac: "detail", at: "json", pg: pg || 1 }
      if (t) {
        params.t = source.id_map && source.id_map[t] ? source.id_map[t] : t
      }
      if (wd) params.wd = wd
      if (h) params.h = h
      return params
    })

    const responseData = result.data
    let list = (responseData.list || []).map((item) => ({
      id: item.vod_id,
      title: item.vod_name,
      type: item.type_name,
      poster: item.vod_pic,
      remarks: item.vod_remarks,
      year: item.vod_year,
      rating: item.vod_score,
      overview: item.vod_content
        ? item.vod_content.replace(/<[^>]+>/g, "")
        : "",
    }))

    if (year && year !== "全部") {
      list = list.filter((v) => v.year == year)
    }

    success(res, {
      list,
      total: responseData.total,
      pagecount: responseData.pagecount,
      source: result.sourceName,
    })
  } catch (error) {
    fail(res, "所有线路均繁忙，请稍后重试")
  }
})

// [业务] 详情页
app.get("/api/detail/:id", async (req, res) => {
  const { id } = req.params
  try {
    const result = await multiSourceFetch((source) => ({
      ac: "detail",
      at: "json",
      ids: id,
    }))

    const detail = result.data.list[0]
    const parseEpisodes = (urlStr) => {
      if (!urlStr) return []
      return urlStr.split("#").map((ep) => {
        const [name, link] = ep.split("$")
        return { name: link ? name : "正片", link: link || name }
      })
    }

    let playUrl = detail.vod_play_url
    const urls = detail.vod_play_url.split("$$$")
    const froms = detail.vod_play_from.split("$$$")
    const m3u8Index = froms.findIndex((f) => f.toLowerCase().includes("m3u8"))
    if (m3u8Index !== -1 && urls[m3u8Index]) playUrl = urls[m3u8Index]

    success(res, {
      id: detail.vod_id,
      title: detail.vod_name,
      overview: detail.vod_content
        ? detail.vod_content.replace(/<[^>]+>/g, "")
        : "",
      poster: detail.vod_pic,
      type: detail.type_name,
      area: detail.vod_area,
      year: detail.vod_year,
      director: detail.vod_director,
      actors: detail.vod_actor,
      remarks: detail.vod_remarks,
      episodes: parseEpisodes(playUrl),
    })
  } catch (error) {
    fail(res, "资源未找到")
  }
})

// ==========================================
// 4. 用户系统接口 (改为 MongoDB)
// ==========================================

// 注册
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body
  try {
    const existingUser = await User.findOne({ username })
    if (existingUser) return fail(res, "用户已存在", 400)

    const newUser = new User({ username, password, history: [] })
    await newUser.save()

    success(res, { id: newUser._id, username: newUser.username })
  } catch (error) {
    fail(res, "注册失败: " + error.message)
  }
})

// 登录
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body
  try {
    const user = await User.findOne({ username, password })
    if (user) {
      success(res, {
        id: user._id,
        username: user.username,
        history: user.history,
      })
    } else {
      fail(res, "账号或密码错误", 401)
    }
  } catch (error) {
    fail(res, "登录失败")
  }
})

// [POST] 保存/更新历史记录
app.post("/api/user/history", async (req, res) => {
  const { username, video, episodeIndex, progress } = req.body

  if (!username || !video || !video.id) {
    return fail(res, "参数缺失", 400)
  }

  try {
    const user = await User.findOne({ username })
    if (!user) return fail(res, "用户不存在", 404)

    const historyItem = {
      ...video,
      episodeIndex: parseInt(episodeIndex) || 0,
      progress: parseFloat(progress) || 0,
      viewedAt: new Date().toISOString(),
    }

    // 过滤掉旧的同名记录
    // 注意：MongoDB 取出的 array 是 MongooseArray，filter 后是普通 Array
    let newHistory = (user.history || []).filter(
      (h) => String(h.id) !== String(video.id)
    )

    // 插入头部
    newHistory.unshift(historyItem)
    user.history = newHistory.slice(0, 50)

    // ⚠️ 关键：告知 Mongoose 混合类型字段已修改
    user.markModified("history")
    await user.save()

    console.log(`✅ [History] Saved for ${username}`)
    success(res, user.history)
  } catch (error) {
    console.error("History Save Error:", error)
    fail(res, "保存历史记录失败")
  }
})

// [GET] 获取历史记录
app.get("/api/user/history", async (req, res) => {
  const { username } = req.query
  if (!username) return fail(res, "用户名不能为空", 400)

  try {
    const user = await User.findOne({ username })
    if (!user) return success(res, [])
    success(res, user.history || [])
  } catch (error) {
    fail(res, "获取历史失败")
  }
})

app.get("/api/categories", async (req, res) => {
  try {
    const result = await multiSourceFetch((source) => ({
      ac: "list",
      at: "json",
    }))
    success(res, result.data.class || [])
  } catch (e) {
    success(res, [])
  }
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Server running on port ${PORT}`)
  console.log(
    `🛡️  Auto-Failover Mode Enabled (Priority: ${PRIORITY_LIST.join(" -> ")})`
  )
})
