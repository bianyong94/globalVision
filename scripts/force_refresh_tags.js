// scripts/force_refresh_tags.js
console.log("1. 脚本开始执行...")

require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video") // 确保路径对
const { classifyVideo } = require("../utils/classifier")

const BATCH_SIZE = 2000

const run = async () => {
  console.log("4. 数据库连接成功！准备查询数据...")

  try {
    // 先检查一下有多少数据
    const totalCount = await Video.countDocuments({})
    console.log(`📊 数据库中共有 ${totalCount} 条视频。`)

    if (totalCount === 0) {
      console.log("⚠️ 数据库是空的，脚本结束。")
      return
    }

    console.log("5. 开始创建游标 (Cursor)...")
    const cursor = Video.find(
      {},
      {
        _id: 1,
        title: 1,
        original_type: 1,
        overview: 1,
        remarks: 1,
        area: 1,
        year: 1,
        rating: 1,
        tags: 1,
        category: 1,
      }
    )
      .lean()
      .cursor()

    let totalScanned = 0
    let bulkOps = []
    let updatedCount = 0

    console.log("6. 进入循环处理...")

    for (
      let doc = await cursor.next();
      doc != null;
      doc = await cursor.next()
    ) {
      totalScanned++

      // 每扫描 100 条打印一次，证明脚本还活着
      if (totalScanned % 1000 === 0) {
        process.stdout.write(`\r👀 正在扫描第 ${totalScanned} 条...`)
      }

      const mockItem = {
        type_id: 1,
        type_name: doc.original_type || "",
        vod_name: doc.title,
        vod_content: doc.overview || "",
        vod_remarks: doc.remarks,
        vod_area: doc.area,
        vod_year: doc.year,
        vod_score: doc.rating,
      }

      const result = classifyVideo(mockItem)

      if (!result) continue

      const oldTags = doc.tags || []
      const newTags = result.tags
      const oldCategory = doc.category
      const newCategory = result.category

      const isTagsChanged =
        oldTags.length !== newTags.length ||
        !oldTags.every((t) => newTags.includes(t))
      const isCategoryChanged = oldCategory !== newCategory

      if (isTagsChanged || isCategoryChanged) {
        bulkOps.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { tags: newTags, category: newCategory } },
          },
        })
        updatedCount++
      }

      if (bulkOps.length >= BATCH_SIZE) {
        process.stdout.write(`\n⚡ 正在写入 ${bulkOps.length} 条数据...`)
        await Video.bulkWrite(bulkOps)
        console.log(` -> 写入成功 (累计更新: ${updatedCount})`)
        bulkOps = []
        if (global.gc) global.gc()
      }
    }

    if (bulkOps.length > 0) {
      console.log(`\n⚡ 写入剩余的 ${bulkOps.length} 条数据...`)
      await Video.bulkWrite(bulkOps)
    }

    console.log(`\n🎉 全部完成！扫描: ${totalScanned} | 更新: ${updatedCount}`)
  } catch (err) {
    console.error("\n❌ 脚本运行出错:", err)
  }
}

// --- 连接逻辑 ---
const MONGO_URI = process.env.MONGO_URI
console.log("2. 检查环境变量...")

if (!MONGO_URI) {
  console.error("❌ 错误: 未找到 MONGO_URI，请检查 .env 文件")
  process.exit(1)
} else {
  // 只打印前几位，防止泄露密码
  console.log(`✅ 找到连接字符串: ${MONGO_URI.substring(0, 15)}...`)
}

console.log("3. 正在连接 MongoDB (如果卡在这里超过 10秒，请检查 IP 白名单)...")

// 设置连接超时 10秒
mongoose
  .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
  .then(async () => {
    await run()
    console.log("👋 脚本退出")
    process.exit(0)
  })
  .catch((e) => {
    console.error("\n❌ 数据库连接失败！原因如下：")
    console.error(e.message)
    process.exit(1)
  })
