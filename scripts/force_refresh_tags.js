require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video")
const { classifyVideo } = require("../utils/classifier")

const run = async () => {
  console.log("🚀 开始全量刷新视频标签 (基于最新的 classifier 规则)...")

  // 1. 查找所有视频 (使用 cursor 游标防止内存溢出)
  // 只查询必要的字段以提高速度
  const cursor = Video.find({}).cursor()

  let count = 0
  let updatedCount = 0

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    count++

    // 2. 构造模拟的采集项 (还原 classifyVideo 需要的输入格式)
    // ⚠️ 注意：这里使用数据库里的 original_type 和 title 重新进行判断
    const mockItem = {
      type_id: 1, // 给个默认ID防止报错，主要靠 type_name 判断
      type_name: doc.original_type || "",
      vod_name: doc.title,
      vod_content: doc.overview || "", // 简介也参与判断
      vod_remarks: doc.remarks,
      vod_area: doc.area,
      vod_year: doc.year,
      vod_score: doc.rating,
    }

    // 3. 使用最新的规则重新计算
    const result = classifyVideo(mockItem)

    if (result && result.tags) {
      // 4. 比较新旧标签，只有变动了才保存 (优化性能)
      const oldTags = doc.tags || []
      const newTags = result.tags

      // 简单的去重合并逻辑：保留原有的 high_score 等特殊标签，合并新计算出的类型标签
      // 或者直接覆盖？为了保证准确性，建议直接覆盖分类标签，但保留高分标签
      // 这里为了稳妥，我们直接用新算出来的标签覆盖 (因为新规则包含了所有逻辑)

      // 检查是否发生变化
      const isDifferent =
        oldTags.length !== newTags.length ||
        !oldTags.every((t) => newTags.includes(t))

      if (isDifferent) {
        doc.tags = newTags
        // 如果你需要同时纠正分类 (比如把之前分错的纠正过来)，把下面这行注释打开
        // doc.category = result.category;

        await doc.save()
        updatedCount++
        process.stdout.write(
          `\r✅ 已扫描: ${count} | 已更新: ${updatedCount} | 最新更新: ${
            doc.title
          } -> [${newTags.join(",")}]`
        )
      }
    }

    if (count % 1000 === 0) {
      // 防止内存泄露
      if (global.gc) global.gc()
    }
  }

  console.log(`\n\n🎉 刷新完成！`)
  console.log(`总扫描: ${count}`)
  console.log(`实际更新: ${updatedCount}`)
}

const MONGO_URI = process.env.MONGO_URI
if (!MONGO_URI) {
  console.error("❌ MONGO_URI missing")
  process.exit(1)
}

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    await run()
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
