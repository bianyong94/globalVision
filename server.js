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
const { startSourceProbeScheduler } = require("./services/sourceProbeScheduler")
const {
  startTrendingIngestScheduler,
} = require("./services/trendingIngestScheduler")

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
app.use((req, res, next) => {
  const start = process.hrtime.bigint()
  const originalEnd = res.end

  res.end = function (...args) {
    try {
      if (!res.headersSent) {
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
        res.setHeader("X-Response-Time", `${elapsedMs.toFixed(1)}ms`)
      }
    } catch (e) {}
    return originalEnd.apply(this, args)
  }

  res.on("finish", () => {
    const p = `${req.baseUrl || ""}${req.path || ""}`
    if (p.startsWith("/api/video/proxy") || p.startsWith("/api/image/proxy"))
      return
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    const slowMs = Number.parseInt(
      String(process.env.SLOW_REQUEST_MS || "1200"),
      10,
    )
    const threshold = Number.isFinite(slowMs) && slowMs > 0 ? slowMs : 1200
    if (elapsedMs >= threshold) {
      console.warn(
        `[SlowRequest] ${req.method} ${p} ${res.statusCode} ${elapsedMs.toFixed(1)}ms`,
      )
    }
  })

  next()
})
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true)
      const allowList = new Set([
        "https://www.bycurry.cc",
        "https://bycurry.cc",
        "https://global-vision-web.vercel.app",
        "https://localhost",
        "http://localhost",
        "capacitor://localhost",
      ])
      if (allowList.has(origin)) return callback(null, true)
      try {
        const parsed = new URL(origin)
        const isLocalHost =
          parsed.hostname === "localhost" ||
          parsed.hostname === "127.0.0.1" ||
          parsed.hostname === "::1"
        const isPrivateLan =
          /^192\.168\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname) ||
          /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname) ||
          /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(
            parsed.hostname,
          )
        if ((isLocalHost || isPrivateLan) && /^5\d{3}$|^3000$/.test(parsed.port)) {
          return callback(null, true)
        }
      } catch (e) {}
      return callback(new Error(`CORS blocked origin: ${origin}`))
    },
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
app.use("/api", (req, res, next) => {
  const p = String(req.path || "")
  if (p.startsWith("/image/proxy") || p.startsWith("/video/proxy"))
    return next()
  return apiLimiter(req, res, next)
})

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
        runEnrichTask(false).catch((e) => console.error("清洗任务出错了:", e))
      }
    }, 5000)

    startResourceUpdateScheduler()
    startRatingBackfillScheduler()
    startSourceProbeScheduler()
    startTrendingIngestScheduler()
  }
})
