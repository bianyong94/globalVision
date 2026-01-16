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
    origin: process.env.NODE_ENV === "production" ? "*" : "*",
    optionsSuccessStatus: 200,
  })
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

    if (syncMode === "full") {
      console.log(`🔥🔥🔥 强制触发 [全量采集] (从第 ${startPage} 页开始)...`)
      syncTask(876000, startPage).catch((e) => console.error(e))
    } else if (count === 0) {
      console.log("✨ 数据库为空，自动触发 [全量采集]...")
      syncTask(876000, 1).catch((e) => console.error(e))
    } else {
      console.log("🔄 自动触发 [增量采集] (最近6小时)...")
      syncTask(6).catch((e) => console.error(e))
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
  syncTask(3)
})
