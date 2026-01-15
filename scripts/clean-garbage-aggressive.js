// scripts/clean-nuclear.js
require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video")

const MONGO_URI = process.env.MONGO_URI

async function runNuclearCleanup() {
  if (!MONGO_URI) throw new Error("❌ MONGO_URI 未配置")

  console.log("☢️ 警告：即将执行【无差别】清理任务...")
  console.log("👉 凡是未经过 TMDB 匹配的数据，都将被永久删除。")

  await mongoose.connect(MONGO_URI)

  // ==================================================
  // 🔥 核心逻辑：删除所有“非正规军”
  // ==================================================
  const result = await Video.deleteMany({
    $or: [
      { tmdb_id: { $exists: false } }, // 字段不存在 (还没洗，或者洗漏了)
      { tmdb_id: null }, // 字段为空
      { tmdb_id: -1 }, // 搜不到
      { tmdb_id: 0 }, // 异常值
    ],
  })

  console.log("\n========================================")
  console.log(`🗑️ 清理完成！`)
  console.log(`💥 共删除了 ${result.deletedCount} 条“无身份”数据。`)
  console.log(`✅ 剩下的数据全是拥有 TMDB ID 的正规影视资源。`)
  console.log("========================================")

  process.exit()
}

runNuclearCleanup().catch((e) => console.error(e))
