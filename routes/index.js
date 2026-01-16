const express = require("express")
const router = express.Router()

const videoRoutes = require("./video.routes")
const userRoutes = require("./user.routes")
const tmdbController = require("../controllers/tmdbController")
const systemController = require("../controllers/systemController")
const videoController = require("../controllers/videoController") // 为了 detail

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

// AI (注意：限流中间件在 server.js 引用或在这里引用)
const { aiLimiter } = require("../middleware/rateLimit")
router.post("/ai/ask", aiLimiter, systemController.askAI)

module.exports = router
