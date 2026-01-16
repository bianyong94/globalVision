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

// Middleware
const { apiLimiter } = require("./middleware/rateLimit")

// Routes
const apiRoutes = require("./routes/index")

const app = express()
const PORT = process.env.PORT || 3000

// 1. Init Core Services
initRedis()
connectDB() // MongoDB 连接是异步的，但我们先启动服务

// 2. Middleware
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

// 3. Mount Routes
app.use("/api", apiRoutes)

// 4. Global Error Handler
app.use((err, req, res, next) => {
  console.error("Global Error:", err)
  res.status(500).json({ code: 500, message: "Server Internal Error" })
})

// 5. Start Server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`)

  if (process.env.INIT_MODE === "true") {
    console.log("⚠️ 检测到 INIT_MODE=true，将在 5秒后 开始清空并重新采集...")

    const { resetAndSync } = require("./scripts/reset_and_sync")

    setTimeout(() => {
      // 不使用 await，让它在后台跑，不阻塞 Web 访问
      resetAndSync()
        .then(() => {
          console.log("🏁 后台初始化采集完成！")
        })
        .catch((e) => console.error(e))
    }, 5000)
  }
})

// Cron (独立于 SetInterval 的 Cron)
cron.schedule("0 */2 * * *", () => {
  syncTask(3)
})
