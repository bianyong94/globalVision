// scripts/clean-priority.js
require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video")

const MONGO_URI = process.env.MONGO_URI

// 🔥 1. 定义源的优先级 (越靠前越尊贵，保留优先级最高)
// 你可以根据你的喜好调整顺序，没在列表里的源优先级最低
const SOURCE_RANK = {
  maotai: 1,
  feifan: 2,
  hongniu: 3,
  liangzi: 4,
  ikun: 5,
  // ... 其他
}

// 获取优先级数字 (数字越小越厉害，未知的设为 999)
const getSourceRank = (source) => {
  return SOURCE_RANK[source] || 999
}

// 提取标题特征（区分季度/剧场版）
const getTitleFeature = (title) => {
  if (!title) return "default"
  let feature = "default"
  const seasonMatch = title.match(
    /第([0-9一二三四五六七八九十]+)季|Season\s?(\d+)|S(\d+)/i
  )
  if (seasonMatch) {
    const num = seasonMatch[1] || seasonMatch[2] || seasonMatch[3]
    feature = `s${num}`
  }
  if (title.includes("剧场版")) feature += "_movie"
  if (title.includes("特别篇") || title.includes("OVA")) feature += "_special"
  return feature
}

async function runPriorityCleanup() {
  if (!MONGO_URI) throw new Error("❌ MONGO_URI 未配置")

  console.time("⏱️ 总耗时")
  console.log("🔌 连接数据库...")
  await mongoose.connect(MONGO_URI)

  // 1. 全量下载 (轻量字段)
  console.log("📥 正在下载所有已匹配数据...")
  const allVideos = await Video.find({ tmdb_id: { $exists: true } })
    .select("_id tmdb_id source title updatedAt")
    .lean()

  console.log(`✅ 下载完成: ${allVideos.length} 条。开始优先级排序...`)

  // 2. 排序逻辑 (核心)
  // 第一关键字: TMDB ID (把同一部片排在一起)
  // 第二关键字: 标题特征 (把同一季排在一起)
  // 第三关键字: 源优先级 (茅台排前面，量子排后面) 🔥🔥🔥
  // 第四关键字: 更新时间 (最新的排前面)
  allVideos.sort((a, b) => {
    if (a.tmdb_id !== b.tmdb_id) return a.tmdb_id - b.tmdb_id

    const featA = getTitleFeature(a.title)
    const featB = getTitleFeature(b.title)
    if (featA !== featB) return featA.localeCompare(featB)

    const rankA = getSourceRank(a.source)
    const rankB = getSourceRank(b.source)
    if (rankA !== rankB) return rankA - rankB // 优先级高的排前面

    return new Date(b.updatedAt) - new Date(a.updatedAt) // 新的排前面
  })

  // 3. 标记删除
  const idsToDelete = []
  let prevVideo = null

  for (const doc of allVideos) {
    if (!prevVideo) {
      prevVideo = doc
      continue
    }

    const isSameTmdbId = prevVideo.tmdb_id === doc.tmdb_id

    if (isSameTmdbId) {
      const prevFeature = getTitleFeature(prevVideo.title)
      const currFeature = getTitleFeature(doc.title)

      if (prevFeature === currFeature) {
        // 🔥 发现重复！
        // 因为我们已经按“优先级”排过序了，prevVideo 肯定是优先级更高的那个 (比如茅台)
        // 所以当前的 doc (比如量子) 就是多余的，直接删掉。

        // console.log(`   [重复] 保留: ${prevVideo.source} | 删除: ${doc.source} (${doc.title})`);
        idsToDelete.push(doc._id)

        // prevVideo 指针不动，继续往下找，可能后面还有优先级更低的(红牛)也要删
      } else {
        // ID一样但季度不一样 (S1 vs S2)，保留
        prevVideo = doc
      }
    } else {
      // ID不一样，新的一组
      prevVideo = doc
    }
  }

  console.log(`🔍 分析完成！将删除 ${idsToDelete.length} 条低优先级重复数据。`)

  // 4. 执行删除
  if (idsToDelete.length > 0) {
    console.log("🗑️ 正在批量删除...")
    const BATCH_SIZE = 1000
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
      const chunk = idsToDelete.slice(i, i + BATCH_SIZE)
      await Video.deleteMany({ _id: { $in: chunk } })
      process.stdout.write(".")
    }
    console.log("\n✅ 删除完毕！")
  } else {
    console.log("✨ 数据库非常干净，无需清理。")
  }

  console.timeEnd("⏱️ 总耗时")
  process.exit()
}

runPriorityCleanup().catch((e) => console.error(e))
