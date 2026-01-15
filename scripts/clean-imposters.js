// scripts/clean-imposters.js
require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video")

const MONGO_URI = process.env.MONGO_URI

async function runImposterCleanup() {
  if (!MONGO_URI) throw new Error("❌ MONGO_URI 未配置")

  await mongoose.connect(MONGO_URI)
  console.log("🕵️‍♂️ 开始扫描“伪装成电影的垃圾短剧”...")

  // 1. 定义垃圾特征 (根据你的截图，"反转爽剧" 是核心特征)
  // 这些词出现在 original_type 里，绝对不是正经 TMDB 电影
  const garbageTypes = [
    "短剧",
    "爽文",
    "爽剧",
    "反转",
    "赘婿",
    "战神",
    "逆袭",
    "重生",
    "现代都市",
    "脑洞",
    "神医",
    "合集",
    "全集",
  ]
  const typeRegex = new RegExp(garbageTypes.join("|"), "i")

  // 2. 查找：既有 tmdb_id (被清洗过)，由于 original_type 是垃圾
  const imposters = await Video.find({
    tmdb_id: { $exists: true },
    $or: [
      { original_type: typeRegex },
      { type: typeRegex }, // 有些源字段叫 type
      { title: typeRegex }, // 标题里含这些词
    ],
  }).select("title original_type source tmdb_id")

  console.log(`🔍 发现了 ${imposters.length} 个伪装者！`)

  if (imposters.length > 0) {
    // 打印几个看看，确认没误杀
    console.log("示例伪装数据:", imposters.slice(0, 3))

    // 3. 批量删除
    const ids = imposters.map((v) => v._id)
    const res = await Video.deleteMany({ _id: { $in: ids } })
    console.log(`✅ 成功删除了 ${res.deletedCount} 条伪装数据。`)
  } else {
    console.log("✨ 数据库很干净，没有发现伪装者。")
  }

  process.exit()
}

runImposterCleanup().catch((e) => console.error(e))
