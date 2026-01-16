const rateLimit = require("express-rate-limit")

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { code: 429, message: "Too many requests" },
  standardHeaders: true,
  legacyHeaders: false,
})

const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { code: 429, message: "AI 服务繁忙，请稍后再试" },
})

module.exports = { apiLimiter, aiLimiter }
