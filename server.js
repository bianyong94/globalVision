require("dotenv").config()
const express = require("express")
const cors = require("cors")
const compression = require("compression")
const cron = require("node-cron")

// Config & DB
const connectDB = require("./config/db")
const { initRedis } = require("./config/redis")
const { syncTask } = require("./scripts/sync")
const { runEnrichTask } = require("./scripts/enrich")

// 1. 🔥🔥🔥 补全丢失的模型引入
const Video = require("./models/Video")

// Middleware
const { apiLimiter } = require("./middleware/rateLimit")

// Routes
const apiRoutes = require("./routes/index")

const app = express()
const PORT = process.env.PORT || 3000

// 2. Init Core Services
initRedis()
connectDB()

// 3. Middleware
app.set("trust proxy", 1)
app.use(compression())
app.use(
  cors({
    // origin: process.env.NODE_ENV === "production" ? "*" : "*",
    // optionsSuccessStatus: 200,
    origin: [
      // 1. 你的线上前端域名 (如果有的话，比如 Vercel 的地址)
      "https://www.bycurry.cc",
      "https://global-vision-web.vercel.app", // 举例

      // 2. Android App 必备 (Capacitor)
      "https://localhost",
      "http://localhost",
      // 3. iOS App 必备 (Capacitor)
      "capacitor://localhost",
      "http://172.19.203.212:3000",
      "http://172.19.203.212:5173",
      "http://172.19.203.212:5174",

      // 4. 本地开发调试
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:3000",

      // 5. 允许所有 IP (如果你想允许局域网调试)
      // 注意：这只是一个正则示例，生产环境建议去掉下面这行
      // /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d{4}$/
    ],
    credentials: true, // 允许携带 Cookie 或认证头
    optionsSuccessStatus: 200,
  }),
)
app.use(express.json())

// 全局 API 限流
app.use("/api/", apiLimiter)

// 4. Mount Routes
app.use("/api", apiRoutes)

// 5. Global Error Handler
app.use((err, req, res, next) => {
  console.error("Global Error:", err)
  res.status(500).json({ code: 500, message: "Server Internal Error" })
})

// 6. 智能同步函数
const checkAndSync = async () => {
  try {
    const count = await Video.countDocuments()
    console.log(`📊 当前数据库视频数量: ${count}`)

    // 🔥 读取环境变量 (在 Zeabur 变量里设置)
    // START_PAGE: 从第几页开始跑 (例如 1761)
    // SYNC_MODE: 'full' 强制跑全量
    const startPage = process.env.START_PAGE
      ? parseInt(process.env.START_PAGE)
      : 1
    const syncMode = process.env.SYNC_MODE

    // if (syncMode === "full") {
    //   console.log(`🔥🔥🔥 强制触发 [全量采集] (从第 ${startPage} 页开始)...`)
    //   syncTask(876000, startPage).catch((e) => console.error(e))
    // }
    if (count === 0) {
      console.log("✨ 数据库为空，自动触发 [全量采集]...")
      syncTask(876000, 1).catch((e) => console.error(e))
    } else {
      console.log("🔄 自动触发 [增量采集] (最近6小时)...")
      syncTask(6).catch((e) => console.error(e))
    }

    const dirtyCount = await Video.countDocuments({
      is_enriched: false,
      tmdb_id: { $ne: -1 },
    })

    if (dirtyCount > 0) {
      console.log(`🧹 发现 ${dirtyCount} 条未清洗数据，启动后台清洗任务...`)
      // 不使用 await，让它在后台慢慢跑，不要阻塞 Server 启动太久
      runEnrichTask(false).catch((e) => console.error("清洗任务出错:", e))
    } else {
      console.log("✅ 所有数据已清洗")
    }
  } catch (e) {
    console.error("检查数据库状态失败:", e)
  }
}

// 7. Start Server (放在最后)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`)
  // 启动后执行检查
  if (process.env.NODE_ENV === "production") {
    checkAndSync()
  }
})

// Cron (定时任务)
cron.schedule("0 */2 * * *", () => {
  console.log("⏰ 定时任务触发：开始增量采集...")
  // if (process.env.NODE_ENV === "production") syncTask(3)
})
