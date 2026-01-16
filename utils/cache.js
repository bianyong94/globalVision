const NodeCache = require("node-cache")
const { getClient } = require("../config/redis")

const localCache = new NodeCache({ stdTTL: 600, checkperiod: 120 })

const getCache = async (key) => {
  const redisClient = getClient()
  try {
    if (redisClient) {
      const data = await redisClient.get(key)
      return data ? JSON.parse(data) : null
    }
    return localCache.get(key)
  } catch (e) {
    return null
  }
}

const setCache = async (key, data, ttlSeconds = 600) => {
  const redisClient = getClient()
  try {
    if (redisClient) {
      await redisClient.set(key, JSON.stringify(data), "EX", ttlSeconds)
    } else {
      localCache.set(key, data, ttlSeconds)
    }
  } catch (e) {
    console.error("Set Cache Error:", e)
  }
}

module.exports = { getCache, setCache }
