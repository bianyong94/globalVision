// services/syncService.js
const axios = require("axios")
const Video = require("../models/Video")
const { sources } = require("../config/sources")
const { getAxiosConfig } = require("./videoService")

// 🎯 定义
const SYNC_SOURCES = ["feifan", "liangzi", "maotai"]
const BACKFILL_SOURCES = ["feifan", "liangzi"] // 只补这两个快的

// ==========================================
// 🛠️ 基础：处理单条 (被增量同步调用)
// ==========================================
async function processExternalItem(sourceKey, item) {
  try {
    const video = await Video.findOne({ title: item.vod_name })
    if (video) {
      const existingKeys = video.sources.map((s) => s.source_key)
      if (!existingKeys.includes(sourceKey)) {
        video.sources.push({
          source_key: sourceKey,
          source_name: sources[sourceKey].name,
          vod_play_url: item.vod_play_url,
          remarks: item.vod_remarks,
        })
        video.updatedAt = new Date()
        await video.save()
        return "updated"
      }
    }
    return "no_change"
  } catch (e) {
    return "error"
  }
}

// ==========================================
// ⚡ 智能补全 (Smart Backfill) - 修正版
// ==========================================
exports.runSmartBackfill = async () => {
  console.log("🕵️ [Backfill] 正在分析数据库待补全列表...")

  // 🔥 核心修正：精准查找“残缺”数据
  // 逻辑：找出 sources 数组中，source_key 不包含 feifan 或者 不包含 liangzi 的视频
  const query = {
    $or: [
      { "sources.source_key": { $ne: "feifan" } },
      { "sources.source_key": { $ne: "liangzi" } },
    ],
  }

  const pendingCount = await Video.countDocuments(query)

  if (pendingCount === 0) {
    console.log("✅ [Backfill] 所有视频均已包含非凡和量子源，无需补全。")
    return
  }

  console.log(
    `⚡ [Backfill] 发现 ${pendingCount} 个视频缺少快源，开始极速清洗...`,
  )

  // 游标遍历
  const cursor = Video.find(query).cursor()

  let totalProcessed = 0
  let totalUpdated = 0
  let batch = []
  const BATCH_SIZE = 15 // 并发数

  for (
    let video = await cursor.next();
    video != null;
    video = await cursor.next()
  ) {
    batch.push(video)

    if (batch.length >= BATCH_SIZE) {
      const results = await processBatch(batch)
      totalUpdated += results
      totalProcessed += batch.length

      process.stdout.write(
        `\r🚀 [Backfill] 进度: ${totalProcessed}/${pendingCount} | 本轮修复: ${results}`,
      )

      batch = []
      // 稍微歇一下
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  if (batch.length > 0) {
    const results = await processBatch(batch)
    totalUpdated += results
    console.log(
      `\r🚀 [Backfill] 尾部处理: ${batch.length} | 本轮修复: ${results}`,
    )
  }

  console.log(`\n🎉 [Backfill] 清洗完成！总计修复: ${totalUpdated} 条。`)
}

// 辅助：批量处理
async function processBatch(videos) {
  const tasks = videos.map(async (video) => {
    let isModified = false
    const existingKeys = video.sources.map((s) => s.source_key)

    // 遍历我们需要补的源 (feifan, liangzi)
    for (const targetKey of BACKFILL_SOURCES) {
      // 🛡️ 关键判断：如果这个视频已经有这个key了，就跳过
      // 比如它有 maotai + feifan，只缺 liangzi，那 feifan 这轮循环就会跳过
      if (existingKeys.includes(targetKey)) continue

      try {
        const sourceConfig = sources[targetKey]
        const res = await axios.get(sourceConfig.url, {
          params: { ac: "detail", wd: video.title },
          timeout: 4000,
          ...getAxiosConfig(),
        })

        const list = res.data?.list || []
        const match = list.find((item) => item.vod_name === video.title)

        if (match) {
          video.sources.push({
            source_key: targetKey,
            source_name: sourceConfig.name,
            vod_play_url: match.vod_play_url,
            remarks: match.vod_remarks,
          })
          isModified = true
        }
      } catch (e) {
        /* error */
      }
    }

    if (isModified) {
      await video.save()
      return 1
    }
    return 0
  })

  const results = await Promise.all(tasks)
  return results.reduce((a, b) => a + b, 0)
}

// ==========================================
// 🐢 增量同步 (日常)
// ==========================================
exports.syncRecentUpdates = async (hours = 24) => {
  console.log(`⏰ [Cron] 开始增量同步 (最近 ${hours}h)...`)
  for (const key of SYNC_SOURCES) {
    try {
      const config = sources[key]
      const res = await axios.get(config.url, {
        params: { ac: "detail", h: hours },
        timeout: 10000,
        ...getAxiosConfig(),
      })

      const list = res.data?.list || []
      console.log(`   📡 [${config.name}] 更新: ${list.length} 条`)

      let count = 0
      for (const item of list) {
        const res = await processExternalItem(key, item)
        if (res === "updated") count++
      }
    } catch (e) {
      console.error(`   ❌ [${key}] 失败: ${e.message}`)
    }
  }
}
