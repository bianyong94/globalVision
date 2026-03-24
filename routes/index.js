const express = require("express")
const router = express.Router()

const videoRoutes = require("./video.routes")
const userRoutes = require("./user.routes")
const tmdbController = require("../controllers/tmdbController")
const systemController = require("../controllers/systemController")
const videoController = require("../controllers/videoController") // 为了 detail
const imageController = require("../controllers/imageController")
const videoProxyController = require("../controllers/videoProxyController")
const sourceMetricsController = require("../controllers/sourceMetricsController")

// 挂载路由
router.use("/v2", videoRoutes)

// 兼容旧接口
router.get("/detail/:id", videoController.getDetail)
router.get("/categories", systemController.getCategories)

// 用户路由
router.use("/", userRoutes) // /api/auth/..., /api/user/...

// TMDB
router.get("/v2/tmdb/netflix", tmdbController.getNetflix)
router.get("/v2/tmdb/top_rated", tmdbController.getTopRated)
router.get("/image/proxy", imageController.proxyImage)
router.get("/video/proxy/playlist", videoProxyController.proxyPlaylist)
router.get("/video/proxy/playlist.m3u8", videoProxyController.proxyPlaylist)
router.get("/video/proxy/segment", videoProxyController.proxySegment)

const requireAdminToken = (req, res, next) => {
  const token = String(process.env.ADMIN_METRICS_TOKEN || "").trim()
  if (!token) return next()
  const input =
    String(req.query.token || "").trim() ||
    String(req.headers["x-admin-token"] || "").trim()
  if (input !== token) {
    return res.status(401).json({ code: 401, message: "unauthorized" })
  }
  return next()
}

router.get(
  "/admin/video-proxy/stats",
  requireAdminToken,
  videoProxyController.getProxyStats,
)
router.post(
  "/admin/video-proxy/stats/reset",
  requireAdminToken,
  videoProxyController.resetProxyStats,
)
router.get("/v2/source/scores", sourceMetricsController.getSourceScores)

// AI (注意：限流中间件在 server.js 引用或在这里引用)
const { aiLimiter } = require("../middleware/rateLimit")
router.post("/ai/ask", aiLimiter, systemController.askAI)

module.exports = router
