// services/syncService.js

const axios = require("axios")
const Video = require("../models/Video")
const { sources } = require("../config/sources")
const { getAxiosConfig } = require("../services/videoService")

const SYNC_SOURCES = ["feifan", "liangzi", "maotai"]
const BACKFILL_SOURCES = ["feifan", "liangzi"]

// ----------------------------------------------------------------
// 🛠️ 基础逻辑：单条数据匹配入库 (严格对应 Video Schema)
// ----------------------------------------------------------------
async function processExternalItem(sourceKey, item) {
  try {
    const video = await Video.findOne({ title: item.vod_name })
    if (video) {
      const existingKeys = video.sources.map((s) => s.source_key)
      if (!existingKeys.includes(sourceKey)) {
        // 🔥 核心修正：严格按照 SourceSchema 构造对象
        video.sources.push({
          source_key: sourceKey, // 必需
          vod_id: item.vod_id, // 必需 (之前报错就是缺这个)
          vod_name: item.vod_name, // 新增：存入资源站片名
          vod_play_from: item.vod_play_from, // 新增：播放器类型
          vod_play_url: item.vod_play_url, // 必需
          remarks: item.vod_remarks, // 备注 (如: 更新至10集)
          // priority: 0,                // 自动应用 Schema 默认值 0
          // updatedAt: new Date(),      // 自动应用 Schema 默认值 Date.now
        })

        // 更新主文档时间，让它浮到列表前面
        video.updatedAt = new Date()
        await video.save()
        return "updated"
      }
    }
    return "no_change"
  } catch (e) {
    throw e
  }
}

// ----------------------------------------------------------------
// ⚡ 智能补全任务 (Smart Backfill)
// ----------------------------------------------------------------
exports.runSmartBackfill = async () => {
  console.info("🕵️ [Init] 正在检查数据库健康状态...")

  // 1. 精准查询：找出 sources 数组里缺少 "feifan" 或 "liangzi" 的视频
  const query = {
    $or: [
      { "sources.source_key": { $ne: "feifan" } },
      { "sources.source_key": { $ne: "liangzi" } },
    ],
  }

  const pendingCount = await Video.countDocuments(query)

  if (pendingCount === 0) {
    console.success("数据健康！所有视频均已包含非凡或量子源，无需补全。")
    return
  }

  console.warn(
    `发现 ${pendingCount} 个视频缺少快源，启动极速清洗模式 (并发: 15)...`,
  )

  const cursor = Video.find(query).cursor()

  let totalProcessed = 0
  let totalUpdated = 0
  let batch = []
  const BATCH_SIZE = 15

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

      // 每 150 条打印一次日志，防刷屏
      if (totalProcessed % 150 === 0 || totalProcessed === pendingCount) {
        console.info(
          `[Backfill 进度] 已扫描: ${totalProcessed}/${pendingCount} | 本轮修复: ${results} | 总修复: ${totalUpdated}`,
        )
      }

      batch = []
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  if (batch.length > 0) {
    const results = await processBatch(batch)
    totalUpdated += results
    console.info(`[Backfill 完成] 尾部扫描: ${batch.length} | 修复: ${results}`)
  }

  console.success(
    `🎉 旧数据清洗完成！总计修复: ${totalUpdated} 条。下次启动将自动跳过此步骤。`,
  )
}

// 辅助：批量处理
async function processBatch(videos) {
  const tasks = videos.map(async (video) => {
    let isModified = false
    const existingKeys = video.sources.map((s) => s.source_key)

    for (const targetKey of BACKFILL_SOURCES) {
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
          // 🔥 核心修正：推入完整字段
          video.sources.push({
            source_key: targetKey,
            vod_id: match.vod_id, // 必需
            vod_name: match.vod_name, // 新增
            vod_play_from: match.vod_play_from, // 新增
            vod_play_url: match.vod_play_url, // 必需
            remarks: match.vod_remarks,
          })
          isModified = true
        }
      } catch (e) {
        if (e.response?.status !== 404) {
          // 忽略非致命网络错误
        }
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

// ----------------------------------------------------------------
// 🐢 增量同步任务 (日常)
// ----------------------------------------------------------------
exports.syncRecentUpdates = async (hours = 24) => {
  console.info(`⏰ [Cron] 开始增量同步 (最近 ${hours}h)...`)

  for (const key of SYNC_SOURCES) {
    try {
      const config = sources[key]
      const res = await axios.get(config.url, {
        params: { ac: "detail", h: hours },
        timeout: 10000,
        ...getAxiosConfig(),
      })

      const list = res.data?.list || []
      console.info(
        `📡 [${config.name}] 拉取到 ${list.length} 条更新，开始入库...`,
      )

      let count = 0
      for (const item of list) {
        const res = await processExternalItem(key, item)
        if (res === "updated") count++
      }

      if (count > 0) {
        console.success(`✅ [${config.name}] 处理完毕: 新增/更新 ${count} 条`)
      } else {
        console.info(`👌 [${config.name}] 处理完毕: 无需更新`)
      }
    } catch (e) {
      console.error(`[${key}] 同步失败了`, e)
    }
  }
}
