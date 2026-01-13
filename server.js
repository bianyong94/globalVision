console.log("🔥 Application Starting...")

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
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`)
  })
  mongoose
    .connect(MONGO_URI)
    .then(() => {
      // 1. 先启动 HTTP 服务，确保网站立刻能访问

      // 2. 部署后自动触发采集 (后台运行)
      // ✅ 修改后的写法：延迟 10 秒执行，优先保证 Web 服务存活
      setTimeout(() => {
        console.log("⏰ 延迟启动采集任务，防止阻塞启动...")
        runStartupTask()
      }, 10000)
    })
    .catch((err) => console.error("❌ MongoDB Connection Error:", err))
}
// ==========================================
// 🛠️ 辅助函数：启动任务逻辑
// ==========================================
async function runStartupTask() {
  // 判断是否是生产环境 (防止你在本地开发时每次保存代码都疯狂采集)
  // 如果你想本地也跑，可以去掉这个 if 判断
  if (
    process.env.NODE_ENV === "production" ||
    process.env.FORCE_SYNC === "true"
  ) {
    console.log("✨ 部署/启动检测通过，准备执行初始化采集...")

    // 策略 A: 每次重启只采集最近 24 小时 (增量更新，速度快)
    // 适合日常部署维护
    const hours = 24

    // 策略 B: 如果你想初次部署跑全量，可以通过环境变量控制
    // 在宝塔/Docker 设置环境变量 INITIAL_FULL_SYNC=true
    if (process.env.INITIAL_FULL_SYNC === "true") {
      console.log("⚠️ 检测到全量同步标记，开始采集所有历史数据...")
      // 采集 99999 小时相当于全量
      syncTask(99999).catch((e) => console.error("全量采集出错:", e))
    } else {
      console.log("🔄 开始执行启动增量同步 (24h)...")
      syncTask(hours).catch((e) => console.error("增量采集出错:", e))
    }
  } else {
    console.log(
      "👨‍💻 开发环境：跳过自动采集 (如需测试请在 .env 添加 FORCE_SYNC=true)"
    )
  }
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

// server.js 中的 /api/v2/videos 接口

app.get("/api/v2/videos", async (req, res) => {
  try {
    const { cat, tag, area, year, sort, pg = 1, wd } = req.query
    const limit = 20
    const skip = (parseInt(pg) - 1) * limit

    // ==========================================
    // 1. 构建筛选条件 ($match)
    // ==========================================
    const matchStage = {}

    // 🔍 关键词搜索
    if (wd) {
      const regex = new RegExp(wd, "i")
      matchStage.$or = [
        { title: regex },
        { actors: regex },
        { director: regex },
      ]
    }

    // 📂 分类筛选
    if (cat && cat !== "all") {
      matchStage.category = cat
    }

    // 🌍 地区筛选
    if (area) {
      matchStage.area = new RegExp(area)
    }

    // 📅 年份筛选
    if (year && year !== "全部") {
      matchStage.year = parseInt(year)
    }

    // 🏷️ 标签筛选
    if (tag) {
      matchStage.tags = tag
      // 如果是找“高分”或“豆瓣榜单”，必须过滤掉 0 分的垃圾数据
      if (tag === "high_score" || tag === "douban_top") {
        matchStage.rating = { $gt: 0 }
      }
    }

    // ==========================================
    // 2. 构建智能排序逻辑 ($sort) 🔥 核心修改
    // ==========================================
    let sortStage = {}

    if (sort === "rating" || tag === "high_score" || tag === "douban_top") {
      // ✅ 场景 A: 用户想看【高分】
      // 逻辑：先看分数 -> 分数一样看年份(越新越好) -> 年份一样看更新时间
      sortStage = {
        rating: -1, // 1. 评分优先 (10分 > 9分)
        year: -1, // 2. 年份次之 (同9分，2025 > 1990)
        updatedAt: -1, // 3. 更新时间兜底 (同分同年，刚更新的在前后)
      }

      // 再次确保，按评分排时，如果没有筛选 rating>0，这里强制过滤 0 分
      // 避免 0 分的数据因为 year 很大而混在中间（虽然 sort rating:-1 会把 0 放最后，但为了保险）
      if (!matchStage.rating) {
        matchStage.rating = { $gt: 0 }
      }
    } else {
      // ✅ 场景 B: 用户想看【最新】(默认)
      // 逻辑：先看年份 -> 年份一样看更新时间(集数更新) -> 都一样看评分(质量)
      sortStage = {
        year: -1, // 1. 绝对年份优先 (2026 > 2025)
        updatedAt: -1, // 2. 也是2025，刚更新第16集的排在第10集前面
        rating: -1, // 3. 都是2025且同时更新，9.0分的排在2.0分前面
      }
    }

    // ==========================================
    // 3. 执行聚合查询 (Aggregation)
    // ==========================================
    const pipeline = [
      { $match: matchStage }, // 1. 筛选
      { $sort: sortStage }, // 2. 排序
      { $skip: skip }, // 3. 跳页
      { $limit: limit }, // 4. 限制数量
      {
        $project: {
          // 5. 输出字段 (精简数据量)
          title: 1,
          poster: 1,
          rating: 1,
          year: 1,
          remarks: 1,
          tags: 1,
          uniq_id: 1,
          category: 1,
          updatedAt: 1, // 输出这个方便调试看排序是否生效
          id: "$uniq_id", // 别名映射，前端展示需要 id
        },
      },
    ]

    const list = await Video.aggregate(pipeline)

    // ==========================================
    // 4. 返回结果
    // ==========================================
    res.json({ code: 200, list: list })
  } catch (e) {
    console.error("Search API Error:", e)
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
    const fixId = (queryResult) =>
      queryResult.map((item) => {
        // item 可能是 mongoose document，需要转成普通对象
        const doc = item._doc || item
        return {
          ...doc,
          // ✅ 核心：把 uniq_id 赋值给 id
          id: doc.uniq_id || doc.id || doc._id,
        }
      })
    // 并行查询，速度极快
    const [banners, netflix, shortDrama, highRateTv, newMovies] =
      await Promise.all([
        // 轮播图：取最近更新的 4K 电影或 Netflix 剧集
        Video.find({ tags: { $in: ["netflix", "4k"] }, category: "movie" })
          .sort({ updatedAt: -1 })
          .limit(5)
          .select("title poster tags remarks uniq_id"),

        // Section 1: Netflix 独家 (剧集)
        Video.find({ tags: "netflix", category: "tv" })
          .sort({ updatedAt: -1 })
          .limit(10)
          .select("title poster remarks uniq_id"),

        // Section 2: 热门短剧 (专门筛选 miniseries 标签)
        Video.find({ tags: "miniseries" })
          .sort({ updatedAt: -1 })
          .limit(10)
          .select("title poster remarks uniq_id"),

        // Section 3: 高分美剧 (分类+标签+评分排序)
        Video.find({ tags: "欧美", category: "tv", rating: { $gt: 0 } })
          .sort({ rating: -1 })
          .limit(10)
          .select("title poster rating uniq_id"),

        // Section 4: 院线新片
        Video.find({ category: "movie", tags: "new_arrival" })
          .sort({ updatedAt: -1 })
          .limit(12)
          .select("title poster remarks uniq_id"),
      ])

    res.json({
      code: 200,
      data: {
        banners: fixId(banners),
        sections: [
          { title: "Netflix 精选", type: "scroll", data: fixId(netflix) },
          { title: "爆火短剧", type: "grid", data: fixId(shortDrama) },
          { title: "口碑美剧", type: "grid", data: fixId(highRateTv) },
          { title: "院线新片", type: "grid", data: fixId(newMovies) },
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

// ==========================================
// 🔥 [重构] 详情页接口 (强力容错 + 源配置透传)
// ==========================================
app.get("/api/detail/:id", async (req, res) => {
  const { id } = req.params // 例如: "hongniu_951"

  // 1. 缓存检查 (缓存 10 分钟)
  // 注意：开发调试时可以注释掉这就行，方便看实时日志
  const cacheKey = `detail_v4_${id}`
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  // 解析播放列表 (工具函数)
  const parseEpisodes = (urlStr, fromStr) => {
    if (!urlStr) return []
    const froms = (fromStr || "").split("$$$")
    const urls = urlStr.split("$$$")
    // 优先找 m3u8，找不到就找默认的
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

  try {
    let videoDetail = null
    let sourceKey = ""
    let vodId = ""

    // ==========================================
    // 步骤 A: 解析 ID，确定要查询的源
    // ==========================================
    if (id.includes("_") || id.includes("$")) {
      const separator = id.includes("_") ? "_" : "$"
      const parts = id.split(separator)
      sourceKey = parts[0] // "hongniu"
      vodId = parts[1] // "951"
    } else {
      // 兼容旧 ID (纯数字)，默认去非凡查，或者查库
      const exist = await Video.findOne({ vod_id: id })
      if (exist) {
        sourceKey = exist.source
        vodId = String(exist.vod_id)
      } else {
        sourceKey = "feifan" // 默认兜底
        vodId = id
      }
    }

    // ==========================================
    // 步骤 B: 尝试从数据库获取
    // ==========================================
    // 构造查询条件：同时匹配源和ID，防止ID冲突
    videoDetail = await Video.findOne({
      $or: [
        { uniq_id: `${sourceKey}_${vodId}` }, // 新格式
        { uniq_id: `${sourceKey}$${vodId}` }, // 旧格式
        { id: `${sourceKey}_${vodId}` }, // 兼容格式
      ],
    })

    // ==========================================
    // 步骤 C: 数据库没有 -> 触发回源采集 (关键修复)
    // ==========================================
    if (!videoDetail) {
      console.log(
        `🚀 [Detail] DB Miss, Fetching Remote: ${sourceKey} -> ${vodId}`
      )

      // 1. 检查源是否存在于配置中
      const targetSource = sources[sourceKey]
      if (!targetSource) {
        return fail(res, `未知的资源站标识: ${sourceKey}`, 400)
      }

      try {
        // 2. 发起请求 (不使用 smartFetch 的自动竞速，而是强制指定源)
        // ⚠️ 红牛等源速度极慢，给予 8秒 超时
        const response = await axios.get(targetSource.url, {
          params: { ac: "detail", at: "json", ids: vodId },
          timeout: 8000,
          ...getAxiosConfig(),
        })

        // 3. 校验返回数据
        if (
          response.data &&
          response.data.list &&
          response.data.list.length > 0
        ) {
          const rawData = response.data.list[0]
          // 4. 存入数据库 (异步)
          // 必须 await 确保 videoDetail 被赋值
          videoDetail = await saveToDB(rawData, sourceKey)
          console.log(`✅ [Detail] Saved to DB: ${videoDetail.title}`)
        } else {
          console.warn(
            `⚠️ [Detail] Remote API returned empty list: ${sourceKey}`
          )
          return fail(res, "源站返回数据为空，可能资源已失效", 404)
        }
      } catch (fetchErr) {
        console.error(
          `❌ [Detail] Fetch Failed (${sourceKey}):`,
          fetchErr.message
        )
        return fail(res, `源站连接超时或错误: ${fetchErr.message}`, 500)
      }
    }

    // 双重检查
    if (!videoDetail) return fail(res, "资源解析失败", 500)

    // ==========================================
    // 步骤 D: 构建“可用源”列表 (混合模式)
    // ==========================================

    // 1. 数据库里的同名资源 (已采集的)
    const siblings = await Video.find({
      title: videoDetail.title,
    }).select("uniq_id source remarks")

    // 2. 配置文件里的所有源 (静态的)
    // 我们把配置文件里的源也都列出来，方便前端展示“去搜索”按钮
    // 这里的逻辑是：结合数据库已有的状态，生成一个完整的列表
    const allConfiguredSources = Object.keys(sources).map((key) => {
      const sourceConfig = sources[key]
      // 查找数据库里是否已经有这个源的数据
      const existing = siblings.find((s) => s.source === key)

      return {
        key: key,
        name: sourceConfig.name,
        // 如果库里有，就用库里的ID；如果库里没有，前端点击时需要触发“全网搜”
        id: existing ? existing.uniq_id : null,
        remarks: existing ? existing.remarks : "点击搜索",
        is_active: key === sourceKey, // 标记是否是当前播放的源
        has_data: !!existing, // 标记库里是否有数据
      }
    })

    // ==========================================
    // 步骤 E: 返回最终数据
    // ==========================================
    const responseData = {
      id: videoDetail.uniq_id, // 核心 ID
      uniq_id: videoDetail.uniq_id,

      title: videoDetail.title,
      pic: videoDetail.poster || videoDetail.pic,
      year: videoDetail.year,
      area: videoDetail.area,
      content: videoDetail.overview || videoDetail.content,
      actors: videoDetail.actors,
      director: videoDetail.director,
      category: videoDetail.category,
      tags: videoDetail.tags,

      // 播放列表
      episodes: parseEpisodes(
        videoDetail.vod_play_url,
        videoDetail.vod_play_from
      ),

      // 🔥 修复后的源列表 (包含所有配置源)
      available_sources: allConfiguredSources,

      current_source: {
        key: videoDetail.source,
        name: sources[videoDetail.source]?.name || videoDetail.source,
      },
    }

    // 写入缓存
    await setCache(cacheKey, responseData, 600)
    success(res, responseData)
  } catch (e) {
    console.error("🔥 Global Detail Error:", e)
    fail(res, "服务器内部错误: " + e.message)
  }
})
// ==========================================
// 🔥🔥🔥 [新增接口] 全网实时搜索源 (用于换源)
// 前端调用: /api/v2/video/sources?title=庆余年2
// ==========================================
app.get("/api/v2/video/sources", async (req, res) => {
  const { title } = req.query

  if (!title) return fail(res, "缺少标题参数", 400)

  // 1. 缓存检查 (同一个片名搜索结果缓存 10 分钟)
  // 这种实时聚合查询比较消耗服务器带宽，建议加上缓存
  const cacheKey = `sources_search_${encodeURIComponent(title)}`
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    // 2. 获取所有配置的源
    // 我们不使用 PRIORITY_LIST，而是使用 sources 对象的所有 Key，以获取最全的结果
    const allSourceKeys = Object.keys(sources)

    // 3. 并发请求所有源
    // 使用 Promise.allSettled 防止某一个源挂了导致整个接口失败
    const searchPromises = allSourceKeys.map(async (key) => {
      const source = sources[key]
      try {
        // 大多数资源站的搜索接口参数是 wd={title}
        // ac=detail 可以直接获取详情，如果不支持可以改 ac=list
        const response = await axios.get(source.url, {
          params: { ac: "detail", wd: title },
          timeout: 10000, // 设置 4s 超时，防止接口太慢
          ...getAxiosConfig(), // 复用你的代理/Header配置
        })

        const list = response.data?.list || []

        // 4. 精确匹配逻辑
        // 资源站搜索是模糊的，搜"庆余年"可能会出来"庆余年花絮"
        // 我们需要找到跟当前标题高度匹配的那个
        const match = list.find(
          (item) =>
            // 完全相等，或者包含关系(容错)
            item.vod_name === title ||
            (item.vod_name.includes(title) &&
              item.vod_name.length < title.length + 2)
        )

        if (match) {
          return {
            key: key, // 源标识 (feifan)
            name: source.name, // 源名称 (非凡资源)
            // 构造前端跳转需要的 ID 格式
            id: `${key}_${match.vod_id}`,
            // 顺便把更新状态带回去，方便用户对比 (如: "非凡: 更新至30集" vs "量子: 全36集")
            remarks: match.vod_remarks,
            // 如果需要，可以把播放地址也带上，预加载
            // type: match.type_name
          }
        }
        return null
      } catch (err) {
        // console.warn(`源 ${source.name} 搜索超时或失败`);
        return null // 失败忽略
      }
    })

    const results = await Promise.all(searchPromises)

    // 5. 过滤掉无效结果
    const availableSources = results.filter((item) => item !== null)

    if (availableSources.length === 0) {
      // 如果全网都没搜到，返回空数组
      return success(res, [])
    }

    // 6. 存入缓存
    await setCache(cacheKey, availableSources, 600)

    success(res, availableSources)
  } catch (e) {
    console.error("Search Sources Error:", e)
    fail(res, "搜索源失败")
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
// [接口] 获取历史记录 (智能补全海报版)
app.get("/api/user/history", async (req, res) => {
  const { username } = req.query
  if (!username) return success(res, [])

  try {
    const user = await User.findOne({ username })
    if (!user || !user.history || user.history.length === 0) {
      return success(res, [])
    }

    // 1. 提取所有历史记录的 ID
    const historyIds = user.history.map((h) => h.id)

    // 2. 批量去 Video 表查最新的海报、标题
    // (只查需要的字段，速度极快)
    const freshVideos = await Video.find({ uniq_id: { $in: historyIds } })
      .select("uniq_id poster pic title")
      .lean()

    // 3. 转成 Map 方便快速匹配
    const videoMap = {}
    freshVideos.forEach((v) => {
      videoMap[v.uniq_id] = v
    })

    // 4. 组装最终数据 (合并逻辑)
    const enrichedHistory = user.history.map((historyItem) => {
      // 尝试找到最新的视频信息
      const freshInfo = videoMap[historyItem.id]

      return {
        ...historyItem, // 保留进度(progress)、观看时间(viewedAt)等

        // 🔥 核心修复：优先用最新库里的海报，没有则用历史存的，还不行就给空
        poster:
          (freshInfo && (freshInfo.poster || freshInfo.pic)) ||
          historyItem.poster ||
          historyItem.pic ||
          "",

        // 顺便也更新一下标题，防止片名变更
        title: freshInfo ? freshInfo.title : historyItem.title,
      }
    })

    // 5. 过滤掉完全没数据且没标题的坏数据
    const validHistory = enrichedHistory.filter((h) => h && h.title)

    success(res, validHistory)
  } catch (e) {
    console.error("Get History Error:", e)
    success(res, []) // 失败降级返回空，防止前端报错
  }
})

// 添加历史
// [接口] 添加历史记录 (加强版)
app.post("/api/user/history", async (req, res) => {
  const { username, video, episodeIndex, progress } = req.body

  // 基础校验
  if (!username || !video || !video.id) {
    return fail(res, "参数错误: 缺少 username 或 video.id", 400)
  }

  try {
    const user = await User.findOne({ username })
    if (!user) return fail(res, "用户不存在", 404)

    const targetId = String(video.id)

    // 1. 过滤掉已存在的同一部片子 (避免重复，把旧的删了加新的到最前面)
    let newHistory = (user.history || []).filter(
      (h) => String(h.id) !== targetId
    )

    // 2. 构造新的记录对象
    // 🔥 关键点：确保 poster 字段有值
    const posterUrl = video.poster || video.pic || ""

    const historyItem = {
      id: targetId,
      title: video.title || "未知片名",
      poster: posterUrl, // 强制统一字段名为 poster
      pic: posterUrl, // 兼容旧字段
      episodeIndex: parseInt(episodeIndex) || 0,
      progress: parseFloat(progress) || 0,
      viewedAt: new Date().toISOString(),
      // 如果有其他字段想存（比如当前集数名），也可以解构进去
      // ...video
    }

    // 3. 插入到数组开头 (最近观看)
    newHistory.unshift(historyItem)

    // 4. 限制长度 (只存最近 100 条)
    user.history = newHistory.slice(0, 100)

    // 告诉 Mongoose 数组有变化
    user.markModified("history")
    await user.save()

    success(res, user.history)
  } catch (e) {
    console.error("Save History Error:", e)
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
