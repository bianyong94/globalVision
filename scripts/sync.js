require("dotenv").config()
const mongoose = require("mongoose")
const axios = require("axios")
const Video = require("../models/Video")
const { sources, PRIORITY_LIST } = require("../config/sources") // 确保 config/sources.js 存在
const { classifyVideo } = require("../utils/classifier")

// 代理配置 (Zeabur 上通常不需要，但本地开发可能需要)
const { HttpsProxyAgent } = require("https-proxy-agent")
const { getAxiosConfig } = require("../utils/httpAgent") // 复用你封装好的 httpAgent

// ==========================================
// 1. 核心处理函数：智能聚合 (Ingest)
// ==========================================
async function processItem(item, sourceKey) {
  // 1. 基础清洗与黑名单拦截
  const meta = classifyVideo(item)
  if (!meta) return "skipped" // 黑名单数据直接跳过

  const cleanTitle = item.vod_name.trim()
  const cleanYear = parseInt(item.vod_year) || 0

  // 构造标准源对象 (Source Schema)
  const sourceObject = {
    source_key: sourceKey,
    vod_id: String(item.vod_id),
    vod_name: item.vod_name,
    vod_play_url: item.vod_play_url,
    remarks: item.vod_remarks,
    updatedAt: new Date(),
  }

  try {
    // 🔥 策略 A: 精确查找 (是否已存在该源的该资源)
    // 逻辑：如果库里已经存了“红牛的12345号资源”，那我们只更新它的播放链接
    let video = await Video.findOne({
      "sources.source_key": sourceKey,
      "sources.vod_id": String(item.vod_id),
    })

    if (video) {
      // 找到对应的 source 子文档并更新
      const sourceDoc = video.sources.find(
        (s) => s.source_key === sourceKey && s.vod_id === String(item.vod_id)
      )
      if (sourceDoc) {
        // 只更新播放相关字段，绝对不碰 title/poster 等元数据，防止破坏 TMDB 清洗结果
        sourceDoc.vod_play_url = item.vod_play_url
        sourceDoc.remarks = item.vod_remarks
        sourceDoc.updatedAt = new Date()

        // 顺便更新主文档的时间，方便排序
        video.updatedAt = new Date()
        await video.save()
        return "updated"
      }
    }

    // 🔥 策略 B: 聚合查找 (同名同姓匹配)
    // 逻辑：库里没这个源，但可能已经有这部电影（比如已有非凡源，现在来的是红牛源）
    // 只有年份有效时才敢合并，防止“片名一样但年份不同”的误判
    let query = { title: cleanTitle }
    if (cleanYear > 1900) {
      query.year = cleanYear
    }

    // 注意：这里我们优先找“已清洗”的数据，或者同名数据
    video = await Video.findOne(query)

    if (video) {
      // 找到了主条目！把当前源 push 进去
      video.sources.push(sourceObject)
      video.updatedAt = new Date() // 顶到前面去
      await video.save()
      return "merged"
    }

    // 🔥 策略 C: 新建档案 (Create)
    // 逻辑：完全没见过的新片，创建新文档
    await Video.create({
      title: cleanTitle,
      category: meta.category, // 使用分类器的结果
      tags: meta.tags, // 使用分类器的标签
      year: cleanYear,

      // 初始元数据 (等后续 TMDB 清洗脚本来修正)
      poster: item.vod_pic,
      overview: (item.vod_content || "")
        .replace(/<[^>]+>/g, "")
        .substring(0, 200),
      actors: (item.vod_actor || "").substring(0, 200),

      // 初始化源数组
      sources: [sourceObject],

      // 标记为未清洗
      is_enriched: false,
    })

    return "created"
  } catch (err) {
    console.error(`💥 处理失败 [${cleanTitle}]:`, err.message)
    return "error"
  }
}

// ==========================================
// 2. 采集单页逻辑
// ==========================================
const fetchPage = async (sourceConfig, page, hours) => {
  try {
    // 复用你的 axios 配置
    const config = getAxiosConfig()
    const res = await axios.get(sourceConfig.url, {
      params: { ac: "detail", at: "json", pg: page, h: hours },
      ...config,
    })
    return res.data
  } catch (error) {
    console.error(
      `❌ [Fetch Fail] ${sourceConfig.name} Page ${page}: ${error.message}`
    )
    return null
  }
}

// ==========================================
// 3. 单个源同步任务
// ==========================================
const syncSourceTask = async (key, hours) => {
  const source = sources[key]
  if (!source) return

  console.log(`\n🚀 [Start] ${source.name} (Last ${hours}h)...`)

  let page = 1
  let totalPage = 1
  let stats = { updated: 0, merged: 0, created: 0, skipped: 0 }

  do {
    const data = await fetchPage(source, page, hours)
    if (!data || !data.list || data.list.length === 0) break

    totalPage = data.pagecount
    const list = data.list

    // ⚠️ 关键修改：不再使用 bulkWrite，而是串行/并发处理
    // 因为涉及到复杂的“查找->判断->合并”逻辑，bulkWrite 搞不定
    // 使用 Promise.all 并发处理本页 20 条数据，速度依然很快
    const results = await Promise.all(
      list.map((item) => processItem(item, key))
    )

    // 统计结果
    results.forEach((res) => {
      if (stats[res]) stats[res]++
    })

    console.log(
      `📥 ${source.name} P${page}/${totalPage}: +${stats.created} New, ^${stats.merged} Merged, ~${stats.updated} Upd`
    )

    // 简单的防封策略
    await new Promise((r) => setTimeout(r, 200))
    page++
  } while (page <= totalPage)

  console.log(
    `✅ ${source.name} Done. Created:${stats.created}, Merged:${stats.merged}, Updated:${stats.updated}`
  )
}

// ==========================================
// 4. 主入口
// ==========================================
const syncTask = async (hours = 24 * 5) => {
  console.log("========================================")
  console.log(`🔥 智能聚合采集开始 (Time: ${hours}h)`)
  console.log("========================================")

  // 按照配置文件的优先级顺序采集
  // 建议把主力源放前面
  const targetKeys = PRIORITY_LIST // ["maotai", "feifan", ...]

  for (const key of targetKeys) {
    try {
      if (sources[key]) {
        await syncSourceTask(key, hours)
      }
    } catch (e) {
      console.error(`❌ Source ${key} failed:`, e)
    }
  }

  console.log("\n🎉 所有采集任务完成!")
}

// 命令行支持: node scripts/sync.js 999
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI
  if (!MONGO_URI) {
    console.error("❌ 请先配置 .env 文件中的 MONGO_URI")
    process.exit(1)
  }

  mongoose.connect(MONGO_URI).then(async () => {
    const h = process.argv[2] ? parseInt(process.argv[2]) : 24
    await syncTask(h)
    console.log("👋 Bye")
    process.exit(0)
  })
}

module.exports = { syncTask }
