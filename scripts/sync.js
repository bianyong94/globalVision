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
// 2. 增强版：带重试的 Fetch
// ==========================================
const fetchPageWithRetry = async (sourceConfig, page, hours, retries = 3) => {
  const config = getAxiosConfig()

  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(sourceConfig.url, {
        params: { ac: "detail", at: "json", pg: page, h: hours },
        ...config,
        timeout: 15000, // 15秒超时
      })
      return res.data
    } catch (error) {
      const isLast = i === retries - 1
      console.warn(
        `⚠️ [Network] Page ${page} failed (${i + 1}/${retries}): ${
          error.message
        }`
      )

      if (isLast) throw error // 最后一次还没成功，抛出异常让外层处理

      // 等待 2秒 再重试
      await new Promise((r) => setTimeout(r, 2000))
    }
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
const syncSourceTask = async (key, hours, startPage = 1) => {
  const source = sources[key]
  if (!source) return

  console.log(
    `\n🚀 [Start] ${source.name} (Last ${hours}h) starting from Page ${startPage}...`
  )

  let page = startPage
  let totalPage = 9999 // 初始假定
  let stats = { updated: 0, merged: 0, created: 0, skipped: 0 }

  while (page <= totalPage) {
    try {
      const data = await fetchPageWithRetry(source, page, hours)

      if (!data || !data.list || data.list.length === 0) {
        console.log("⚠️ No data in list, stopping.")
        break
      }

      totalPage = data.pagecount
      const list = data.list

      // 并发处理本页数据
      const results = await Promise.all(
        list.map((item) => processItem(item, key))
      )

      results.forEach((res) => {
        if (stats[res]) stats[res]++
      })

      console.log(
        `📥 ${source.name} P${page}/${totalPage}: +${stats.created} New, ^${stats.merged} Merged, ~${stats.updated} Upd`
      )
    } catch (error) {
      // 🔥🔥🔥 核心容错：如果这一页彻底挂了，记录日志，跳过，继续下一页！
      console.error(
        `❌ [Critical Fail] Page ${page} skipped due to error:`,
        error.message
      )
    }

    // 防封 & 继续
    await new Promise((r) => setTimeout(r, 200))
    page++
  }

  console.log(`✅ ${source.name} Done.`)
}

const syncTask = async (hours = 24, startPage = 1) => {
  const targetKeys = PRIORITY_LIST

  for (const key of targetKeys) {
    try {
      if (sources[key]) {
        await syncSourceTask(key, hours, startPage)
      }
    } catch (e) {
      console.error(`❌ Source ${key} failed:`, e)
    }
  }
}

// 命令行支持
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI
  mongoose.connect(MONGO_URI).then(async () => {
    // 参数1: 小时, 参数2: 起始页码
    const h = process.argv[2] ? parseInt(process.argv[2]) : 24
    const p = process.argv[3] ? parseInt(process.argv[3]) : 1
    await syncTask(h, p)
    process.exit(0)
  })
}

module.exports = { syncTask }
