const express = require("express")
const router = express.Router()
const controller = require("../controllers/userController")

router.post("/auth/register", controller.register)
router.post("/auth/login", controller.login)
router.get("/user/history", controller.getHistory)
router.post("/user/history", controller.addHistory)
router.delete("/user/history", controller.clearHistory)

module.exports = router
