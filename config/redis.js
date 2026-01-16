const Redis = require("ioredis")

let redisClient = null

const initRedis = () => {
  try {
    if (process.env.REDIS_CONNECTION_STRING) {
      console.log(
        "尝试连接 Redis...",
        process.env.REDIS_CONNECTION_STRING.substring(0, 10) + "..."
      )
      redisClient = new Redis(process.env.REDIS_CONNECTION_STRING, {
        retryStrategy: (times) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
      })

      redisClient.on("connect", () => console.log("✅ Redis Cache Connected"))
      redisClient.on("error", (err) => {
        console.error("❌ Redis Error (Using Memory Cache):", err.message)
      })
    } else {
      console.log("⚠️ No Redis Config found, using Memory Cache")
    }
  } catch (error) {
    console.error("🔥 Redis Init Critical Error:", error.message)
    redisClient = null
  }
  return redisClient
}

module.exports = { initRedis, getClient: () => redisClient }
