require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video")

mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log("🔄 正在重置所有数据的清洗状态...")
  // 把 is_enriched 重置为 false
  // 把 tmdb_id 重置 (移除)，或者设为 null，以便重新匹配
  const res = await Video.updateMany(
    { tmdb_id: { $ne: -1 } },
    { $set: { is_enriched: false } }, // 🔥 关键：不删除 tmdb_id
  )
  console.log(`✅ 已重置 ${res.modifiedCount} 条数据`)
  process.exit(0)
})
