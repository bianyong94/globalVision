// scripts/fix_data.js
require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video")
const { classifyVideo } = require("../utils/classifier")

const fixData = async () => {
  console.log("🚀 开始执行数据库清洗任务...")
  console.log("⚠️  注意：此操作将删除所有'短剧'并修正'电影/电视剧'分类混淆。")

  const batchSize = 1000
  let cursor = Video.find({}).cursor()

  let processed = 0
  let deletedCount = 0
  let updatedCount = 0
  let operations = []

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    processed++

    // 构造一个模拟的 item 对象传给 classifier
    // 因为 classifier 依赖原始 API 的字段名，我们需要映射一下
    const mockItem = {
      original_type: doc.original_type,
      title: doc.title,
      year: doc.year,
      area: doc.area,
      // 🔥 新增：传入 remarks 和 play_url 以供分类器判断
      remarks: doc.remarks,
      vod_play_url: doc.vod_play_url,
    }

    const result = classifyVideo(mockItem)

    if (!result) {
      // 🛑 Case 1: 结果为 null，说明是短剧或黑名单 -> 删除
      operations.push({
        deleteOne: {
          filter: { _id: doc._id },
        },
      })
      deletedCount++
    } else {
      // ✅ Case 2: 有效数据，检查是否需要更新
      // 只要 category 变了，或者 tags 为空（想补充tags），就更新
      const isCategoryWrong = doc.category !== result.category

      // 简单的判断：如果分类不对，或者由于旧逻辑导致tags很少，我们强制更新一下
      if (isCategoryWrong) {
        operations.push({
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set: {
                category: result.category,
                tags: result.tags,
                // updatedAt: new Date() // 可选：更新时间
              },
            },
          },
        })
        updatedCount++
      }
    }

    // 批量执行
    if (operations.length >= batchSize) {
      await Video.bulkWrite(operations)
      console.log(
        `⏳ 进度: 已处理 ${processed} 条 | 🗑️ 待删除: ${deletedCount} | 🔄 待修正: ${updatedCount}`
      )
      operations = [] // 清空队列
    }
  }

  // 处理剩余的
  if (operations.length > 0) {
    await Video.bulkWrite(operations)
  }

  console.log("---------------------------------------")
  console.log(`🎉 清洗完成！`)
  console.log(`📊 总扫描: ${processed}`)
  console.log(`🗑️ 已删除(短剧等): ${deletedCount}`)
  console.log(`🔄 已修正(分类/标签): ${updatedCount}`)
}

// 启动
const MONGO_URI = process.env.MONGO_URI
if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing")
  process.exit(1)
}

mongoose.connect(MONGO_URI).then(async () => {
  try {
    await fixData()
  } catch (e) {
    console.error(e)
  } finally {
    process.exit(0)
  }
})
