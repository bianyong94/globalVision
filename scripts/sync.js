// scripts/sync.js
require("dotenv").config()
const mongoose = require("mongoose")
const axios = require("axios")
const Video = require("../models/Video")
const { sources, MASTER_KEY } = require("../config/sources")
const { classifyVideo } = require("../utils/classifier")

// 代理支持 (可选)
const { HttpsProxyAgent } = require("https-proxy-agent")
const agent = process.env.PROXY_URL
  ? new HttpsProxyAgent(process.env.PROXY_URL)
  : null

/**
 * 🛠️ 辅助：获取单页数据
 */
const fetchPage = async (sourceConfig, page, hours) => {
  try {
    const res = await axios.get(sourceConfig.url, {
      params: {
        ac: "detail",
        at: "json",
        pg: page,
        h: hours, // 采集最近 N 小时
      },
      timeout: 15000, // 资源站慢，给15秒
      httpAgent: agent,
      httpsAgent: agent,
    })
    return res.data
  } catch (error) {
    console.error(
      `❌ [Fetch Fail] ${sourceConfig.name} Page ${page}: ${error.message}`
    )
    return null
  }
}

/**
 * 🛠️ 辅助：数据清洗 (Raw -> DB Model)
 */
const transformData = (item, sourceKey) => {
  // 1. 调用分类器
  const result = classifyVideo(item)

  // 🛑 黑名单拦截 (短剧/伦理等)
  if (!result) return null

  const { category, tags } = result

  return {
    // 唯一ID: 源_ID (确保同源唯一)
    uniq_id: `${sourceKey}_${item.vod_id}`,
    vod_id: item.vod_id,
    source: sourceKey,

    // 核心信息
    title: item.vod_name.trim(),
    original_type: item.type_name,
    category: category,
    tags: tags,

    // 详情
    poster: item.vod_pic,
    director: (item.vod_director || "").substring(0, 255),
    actors: (item.vod_actor || "").substring(0, 500),
    overview: (item.vod_content || "")
      .replace(/<[^>]+>/g, "")
      .substring(0, 500),
    language: item.vod_lang,
    area: item.vod_area,
    year: parseInt(item.vod_year) || 0,
    date: item.vod_time,
    rating: parseFloat(item.vod_score) || 0,
    remarks: item.vod_remarks,

    // 播放
    vod_play_from: item.vod_play_from,
    vod_play_url: item.vod_play_url,

    updatedAt: new Date(),
  }
}

/**
 * 🔄 任务：同步单个源
 */
const syncSourceTask = async (key, hours) => {
  const source = sources[key]
  if (!source) return

  const isMaster = key === MASTER_KEY // 是否为核心源
  console.log(
    `\n🚀 [Start] ${source.name} [${
      isMaster ? "👑 MASTER" : "🔍 FILLER"
    }] (Last ${hours}h)...`
  )

  let page = 1
  let totalPage = 1
  let savedCount = 0
  let skippedCount = 0
  let errorStreak = 0

  do {
    // 1. 拉取
    const data = await fetchPage(source, page, hours)

    // 2. 校验
    if (!data || !data.list || data.list.length === 0) {
      console.log(`🏁 ${source.name} ended at page ${page}.`)
      break
    }
    totalPage = data.pagecount

    // 3. 初步清洗
    let cleanList = data.list
      .map((item) => transformData(item, key))
      .filter((item) => item !== null) // 过滤掉 null (短剧)

    // 如果这一页全是短剧，直接下一页
    if (cleanList.length === 0) {
      page++
      continue
    }

    // =========================================================
    // 🔥 核心去重逻辑：如果不是 Master，检查库里有没有同名资源
    // =========================================================
    if (!isMaster) {
      // 提取本页所有标题
      const titles = cleanList.map((item) => item.title)

      // 去数据库查：这些标题里，哪些已经存在了？(不分源，只要标题一样就算存在)
      const existDocs = await Video.find({ title: { $in: titles } })
        .select("title")
        .lean()
      const existSet = new Set(existDocs.map((d) => d.title))

      // 只保留数据库里没有的 (Filling the gap)
      const uniqueList = cleanList.filter((item) => !existSet.has(item.title))

      skippedCount += cleanList.length - uniqueList.length
      cleanList = uniqueList // 更新待插入列表
    }

    // 如果过滤完这一页没数据了，跳过写入
    if (cleanList.length === 0) {
      // console.log(`⏭️ Page ${page} all duplicates, skipping write.`); // 可选：减少日志噪音
      page++
      continue
    }

    // 4. 批量写入 (BulkWrite)
    const operations = cleanList.map((doc) => ({
      updateOne: {
        filter: { uniq_id: doc.uniq_id },
        update: { $set: doc, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    }))

    try {
      if (operations.length > 0) {
        await Video.bulkWrite(operations, { ordered: false })
        savedCount += operations.length
        console.log(
          `📥 ${source.name} P${page}/${totalPage}: Saved ${operations.length} items.`
        )
      }
      errorStreak = 0
    } catch (e) {
      console.error(`💥 Write Error: ${e.message}`)
      errorStreak++
    }

    // 防封限速
    await new Promise((r) => setTimeout(r, 500))
    page++

    // 连续错误保护
    if (errorStreak > 10) {
      console.error("🔥 Too many errors, aborting this source.")
      break
    }
  } while (page <= totalPage)

  console.log(
    `✅ ${source.name} Done. Saved: ${savedCount}, Skipped(Dup): ${skippedCount}`
  )
}

/**
 * 🌍 主入口：只跑新源，不跑茅台
 */
const syncTask = async (hours = 24) => {
  console.log("========================================")
  console.log(`🔥 SYNC STARTED (Time: ${hours}h)`)
  console.log(
    `🛑 Ghost Master: ${MASTER_KEY} (Using DB data for deduplication)`
  )
  console.log("========================================")

  // 📝 在这里指定你要跑的源 (排除了 maotai)
  const targetSources = ["feifan", "liangzi", "hongniu"]

  for (const key of targetSources) {
    try {
      if (sources[key]) {
        await syncSourceTask(key, hours)
      }
    } catch (e) {
      console.error(`❌ Source ${key} failed:`, e)
    }
  }

  console.log("\n🎉 ALL TASKS COMPLETED!")
}
// =========================================================
// 🚀 独立运行支持 (node scripts/sync.js 999)
// =========================================================
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI missing in .env")
    process.exit(1)
  }

  // 获取命令行参数小时数，默认24
  const args = process.argv.slice(2)
  const h = args[0] ? parseInt(args[0]) : 24

  mongoose.connect(MONGO_URI).then(async () => {
    await syncTask(h)
    process.exit(0)
  })
}

module.exports = { syncTask }
