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

// 6. 🔥🔥🔥 定义智能同步函数 (必须放在调用之前)
const checkAndSync = async () => {
  try {
    // 检查数据库里有多少视频
    const count = await Video.countDocuments()
    console.log(`📊 当前数据库视频数量: ${count}`)

    if (count === 0) {
      console.log("✨ 检测到数据库为空，自动触发 [全量采集] (100年)...")
      // 876000 小时 ≈ 100年
      syncTask(876000)
        .then(() => {
          console.log("✅ 全量采集完成，开始触发数据清洗...")
          // 采集完了顺便清洗一下，保证数据质量
          runEnrichTask(true)
        })
        .catch((e) => console.error("全量采集失败:", e))
    } else {
      console.log("🔄 检测到已有数据，自动触发 [增量采集] (最近6小时)...")
      syncTask(6).catch((e) => console.error("增量采集失败:", e))
    }
  } catch (e) {
    console.error("检查数据库状态失败:", e)
  }
}

// 7. Start Server (放在最后)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`)
  // 启动后执行检查
  checkAndSync()
})

// Cron (定时任务)
cron.schedule("0 */2 * * *", () => {
  console.log("⏰ 定时任务触发：开始增量采集...")
  syncTask(3)
})
