const express = require("express")
const router = express.Router()
const controller = require("../controllers/videoController")

router.get("/videos", controller.getVideos)
router.get("/home", controller.getHome)
router.get("/video/sources", controller.searchSources)
router.get("/resource/match", controller.matchResource)
// 详情页单独处理，因为它在原代码是 /api/detail/:id 而不是 v2
// 但在 api.js 中我们会做统一前缀处理
router.get("/detail/:id", controller.getDetail)

module.exports = router
