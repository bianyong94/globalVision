// reset.js - 重置所有“搜索失败”的状态，以便重新跑
require("dotenv").config()
const mongoose = require("mongoose")

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/moviestream"

async function resetStatus() {
  await mongoose.connect(MONGO_URI)
  const Video = mongoose.model(
    "Video",
    new mongoose.Schema({}, { strict: false })
  )

  // 把 tmdb_id 为 -1 的全都删掉该字段，变成“未处理”状态
  const res = await Video.updateMany(
    { tmdb_id: -1 },
    { $unset: { tmdb_id: "" } }
  )

  console.log(`已重置 ${res.modifiedCount} 条被标记为“搜索失败”的数据。`)
  process.exit()
}

resetStatus()
