require("dotenv").config()
const express = require("express")
const cors = require("cors")
const compression = require("compression")
const path = require("path")

// Config & DB
const connectDB = require("./config/db")
const { initRedis } = require("./config/redis")
const { runEnrichTask } = require("./scripts/enrich")
const { runSmartBackfill } = require("./services/syncService")
const {
  startResourceUpdateScheduler,
} = require("./services/resourceUpdateScheduler")
const {
  startRatingBackfillScheduler,
} = require("./services/ratingBackfillScheduler")

// const seoMiddleware = require("./middleware/seo")

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
// app.use(seoMiddleware)
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
      "http://localhost:5175",
      "http://localhost:5176",
      "http://localhost:5177",
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

// APK 更新静态目录: /app-update/tv/*
// 例如:
// https://api.bycurry.cc/app-update/tv/latest.json
// https://api.bycurry.cc/app-update/tv/GlobalVisionTV-v1.0.3-release.apk
app.use(
  "/app-update/tv",
  express.static(path.join(__dirname, "app-update", "tv"), {
    maxAge: "7d",
    etag: true,
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith("latest.json")) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate")
      }
      if (filePath.endsWith(".apk")) {
        res.setHeader("Content-Type", "application/vnd.android.package-archive")
      }
    },
  }),
)

// 全局 API 限流
app.use("/api/", apiLimiter)

// 4. Mount Routes
app.use("/api", apiRoutes)

// 5. Global Error Handler
app.use((err, req, res, next) => {
  console.error("Global Error:", err)
  res.status(500).json({ code: 500, message: "Server Internal Error" })
})

// 6. Start Server (放在最后)
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`)

  if (process.env.NODE_ENV === "production") {
    setTimeout(async () => {
      if (String(process.env.BACKFILL_ON_BOOT || "false") === "true") {
        await runSmartBackfill()
      }

      if (String(process.env.ENRICH_ON_BOOT || "false") === "true") {
        runEnrichTask(false).catch((e) => console.error("清洗任务出错:", e))
      }
    }, 5000)

    startResourceUpdateScheduler()
    startRatingBackfillScheduler()
  }
})
