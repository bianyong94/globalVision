// scripts/sync.js
require("dotenv").config()
const mongoose = require("mongoose")
const axios = require("axios")
const Video = require("../models/Video")
const { sources } = require("../config/sources") // 不需要 MASTER_KEY 了，由 targetSources 控制
const { classifyVideo } = require("../utils/classifier")

// 代理支持
const { HttpsProxyAgent } = require("https-proxy-agent")
const agent = process.env.PROXY_URL
  ? new HttpsProxyAgent(process.env.PROXY_URL)
  : null

// 获取单页数据
const fetchPage = async (sourceConfig, page, hours) => {
  try {
    const res = await axios.get(sourceConfig.url, {
      params: { ac: "detail", at: "json", pg: page, h: hours },
      timeout: 15000,
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

// 数据格式转换
const transformData = (item, sourceKey) => {
  const result = classifyVideo(item)
  if (!result) return null // 黑名单拦截

  const { category, tags } = result

  return {
    uniq_id: `${sourceKey}_${item.vod_id}`,
    vod_id: item.vod_id,
    source: sourceKey,

    title: item.vod_name.trim(),
    original_type: item.type_name,
    category: category,
    tags: tags, // 这里的 tags 是基础标签 (如 4K, 动作)

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

    vod_play_from: item.vod_play_from,
    vod_play_url: item.vod_play_url,

    updatedAt: new Date(),
  }
}

// 单源同步任务
const syncSourceTask = async (key, hours) => {
  const source = sources[key]
  if (!source) return

  console.log(`\n🚀 [Start] ${source.name} (Last ${hours}h)...`)

  let page = 1
  let totalPage = 1
  let savedCount = 0

  do {
    const data = await fetchPage(source, page, hours)
    if (!data || !data.list || data.list.length === 0) break

    totalPage = data.pagecount

    // 清洗本页数据
    const cleanList = data.list
      .map((item) => transformData(item, key))
      .filter((item) => item !== null)

    if (cleanList.length === 0) {
      page++
      continue
    }

    // 🔥 批量写入操作 (核心修改点)
    const operations = cleanList.map((doc) => ({
      updateOne: {
        filter: { uniq_id: doc.uniq_id },
        update: {
          $set: doc,
          // 🔥🔥🔥 关键：只要数据更新，就删掉 tmdb_id
          // 这样后台的 enrich-task 就会检测到它变成了"脏数据"，并立刻重新清洗它
          $unset: { tmdb_id: "" },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    }))

    try {
      if (operations.length > 0) {
        await Video.bulkWrite(operations, { ordered: false })
        savedCount += operations.length
        console.log(
          `📥 ${source.name} P${page}/${totalPage}: Updated ${operations.length} items.`
        )
      }
    } catch (e) {
      console.error(`💥 Write Error: ${e.message}`)
    }

    await new Promise((r) => setTimeout(r, 500)) // 防封
    page++
  } while (page <= totalPage)

  console.log(`✅ ${source.name} Done. Total Processed: ${savedCount}`)
}

// 主入口
const syncTask = async (hours = 24) => {
  console.log("========================================")
  console.log(`🔥 SYNC STARTED (Time: ${hours}h)`)
  console.log("========================================")

  // 📝 配置你要跑的源 (按需修改，建议加上 maotai)
  const targetSources = ["maotai", "feifan", "liangzi", "hongniu"]

  // 串行执行，防止并发太高炸内存
  for (const key of targetSources) {
    try {
      if (sources[key]) {
        await syncSourceTask(key, hours)
      }
    } catch (e) {
      console.error(`❌ Source ${key} failed:`, e)
    }
  }

  console.log("\n🎉 ALL SYNC TASKS COMPLETED!")
}

// 允许命令行直接运行: node scripts/sync.js 999
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI
  mongoose.connect(MONGO_URI).then(async () => {
    // 命令行传参数，默认跑24小时
    const h = process.argv[2] ? parseInt(process.argv[2]) : 24
    await syncTask(h)
    process.exit(0)
  })
}

module.exports = { syncTask }
