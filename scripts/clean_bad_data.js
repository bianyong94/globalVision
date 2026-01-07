require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video")

// 🚫 必须清理的关键词 (与 classifier.js 保持一致)
const BLACKLIST = [
  "解说",
  "写真",
  "只有神",
  "av",
  "AV",
  "色情",
  "露点",
  "激情",
  "成人",
  "R级",
  "情色",
  "测试",
  "公告",
]

// 🚫 必须清理的分类名称 (根据你的数据库实际情况)
const BAD_TYPES = ["伦理片", "福利片", "伦理", "福利"]

const cleanTask = async () => {
  console.log("🧹 开始执行数据库大清洗...")

  // 1. 构建正则表达式条件
  const regexConditions = BLACKLIST.map((word) => ({
    // 在 title 或 original_type 中包含黑名单词汇
    $or: [
      { title: { $regex: word, $options: "i" } },
      { original_type: { $regex: word, $options: "i" } },
    ],
  }))

  // 2. 构建分类条件
  const typeConditions = {
    original_type: { $in: BAD_TYPES },
  }

  try {
    // 组合所有删除条件
    const query = {
      $or: [...regexConditions, typeConditions],
    }

    // 先查询一下有多少条
    const count = await Video.countDocuments(query)
    console.log(`🔍 发现 ${count} 条违规/脏数据。`)

    if (count > 0) {
      // 执行删除
      const result = await Video.deleteMany(query)
      console.log(`🗑️ 成功删除 ${result.deletedCount} 条数据！`)
    } else {
      console.log("✨ 数据库很干净，无需清理。")
    }
  } catch (e) {
    console.error("❌ 清洗出错:", e)
  }
}

// 启动连接并运行
const MONGO_URI = process.env.MONGO_URI
if (!MONGO_URI) {
  console.error("MONGO_URI missing")
  process.exit(1)
}

mongoose.connect(MONGO_URI).then(async () => {
  await cleanTask()
  process.exit(0)
})
