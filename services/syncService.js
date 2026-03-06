// services/syncService.js

const axios = require("axios")
const fs = require("fs")
const path = require("path")
const Video = require("../models/Video")
const { sources } = require("../config/sources")
const { getAxiosConfig } = require("../utils/httpAgent")

const SYNC_SOURCES = ["feifan", "liangzi", "maotai"]
const BACKFILL_SOURCES = ["feifan", "liangzi"]

// 📝 断点记录文件路径 (放在项目根目录或同级目录)
const CHECKPOINT_FILE = path.join(process.cwd(), "backfill_checkpoint.txt")

const normalizeTitle = (text = "") =>
  String(text)
    .toLowerCase()
    .replace(/第[0-9一二三四五六七八九十百]+[季部]/g, "")
    .replace(/s\d{1,2}/gi, "")
    .replace(/[\s:：·\-—_'"`~!@#$%^&*()（）[\]{}<>《》,，。.?？、\\/|]+/g, "")
    .trim()

const isLikelySameTitle = (a = "", b = "") => {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

// ----------------------------------------------------------------
// 🛠️ 基础逻辑：单条数据匹配入库
// ----------------------------------------------------------------
async function processExternalItem(sourceKey, item) {
  try {
    const video = await Video.findOne({ title: item.vod_name })
    if (video) {
      const existingKeys = (video.sources || []).map((s) => s.source_key)
      if (!existingKeys.includes(sourceKey)) {
        video.sources.push({
          source_key: sourceKey,
          vod_id: item.vod_id,
          vod_name: item.vod_name,
          vod_play_from: item.vod_play_from,
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
    throw e // 让外层捕获
  }
}

// ----------------------------------------------------------------
// ⚡ 智能补全任务 (Smart Backfill) - 支持断点续传
// ----------------------------------------------------------------
exports.runSmartBackfill = async () => {
  console.info("🕵️ [Init] 正在检查数据库健康状态...")

  // 1. 读取上次崩溃时的进度 (Last ID)
  let lastId = null
  if (fs.existsSync(CHECKPOINT_FILE)) {
    lastId = fs.readFileSync(CHECKPOINT_FILE, "utf-8").trim()
    console.log(`📂 发现断点记录，将从 ID: ${lastId} 之后开始继续清洗...`)
  }

  // 2. 构建查询条件
  const query = {
    "sources.source_key": { $nin: BACKFILL_SOURCES },
  }

  // 如果有断点，只查断点之后的数据
  if (lastId) {
    query._id = { $gt: lastId }
  }

  // 计算剩余待处理数量
  const pendingCount = await Video.countDocuments(query)

  if (pendingCount === 0) {
    // 修复：替换 console.success 为 console.log
    console.log(
      "✅ [成功] 数据健康！没有发现需要补全的视频 (或已全部处理完毕)。",
    )
    // 如果处理完了，可以删除断点文件
    if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE)
    return
  }

  console.warn(
    `🚀 发现 ${pendingCount} 个待处理视频，启动极速清洗模式 (并发: 15)...`,
  )

  // 3. 关键：必须按 _id 正序排列，否则断点续传无效
  const cursor = Video.find(query).sort({ _id: 1 }).cursor()

  let totalProcessed = 0
  let totalUpdated = 0
  let batch = []
  const BATCH_SIZE = 15
  let currentLastId = null // 内存中记录当前批次最后的 ID

  try {
    for (
      let video = await cursor.next();
      video != null;
      video = await cursor.next()
    ) {
      batch.push(video)
      currentLastId = video._id // 更新当前指针

      if (batch.length >= BATCH_SIZE) {
        const results = await processBatch(batch)
        totalUpdated += results
        totalProcessed += batch.length

        // 📝 每次处理完一批，立即保存断点到文件
        // 这样即使下一秒崩溃，重启后也只会重复这 15 条
        if (currentLastId) {
          fs.writeFileSync(CHECKPOINT_FILE, currentLastId.toString())
        }

        if (totalProcessed % 150 === 0 || totalProcessed === pendingCount) {
          console.info(
            `[Backfill 进度] 已扫描: ${totalProcessed}/${pendingCount} | 本轮修复: ${results} | 总修复: ${totalUpdated}`,
          )
        }

        batch = []
        // 稍微歇一下，防止 CPU/内存过热，也给 IO 留点时间
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    // 处理剩余尾部
    if (batch.length > 0) {
      const results = await processBatch(batch)
      totalUpdated += results
      // 保存最后的断点
      if (currentLastId)
        fs.writeFileSync(CHECKPOINT_FILE, currentLastId.toString())
      console.info(
        `[Backfill 完成] 尾部扫描: ${batch.length} | 修复: ${results}`,
      )
    }

    // 修复：替换 console.success
    console.log(`🎉 旧数据清洗完成！总计修复: ${totalUpdated} 条。`)

    // 任务全部完成，删除断点文件，下次从头检查
    if (fs.existsSync(CHECKPOINT_FILE)) {
      fs.unlinkSync(CHECKPOINT_FILE)
    }
  } catch (err) {
    console.error("❌ [Backfill] 任务异常中断:", err.message)
    // 这里的 crash 不会丢失进度，因为我们在 loop 里已经保存了 CHECKPOINT_FILE
  }
}

// 辅助：批量处理 (调试版 - 用于定位 0 修复原因)
async function processBatch(videos) {
  const tasks = videos.map(async (video) => {
    try {
      let isModified = false
      const existingKeys = video.sources.map((s) => s.source_key)

      for (const targetKey of BACKFILL_SOURCES) {
        if (existingKeys.includes(targetKey)) continue

        const sourceConfig = sources[targetKey]
        if (!sourceConfig) continue

        try {
          // 1. 打印正在请求谁
          console.log(`🔍 [搜索中] ${video.title} -> ${targetKey}`)

          const res = await axios.get(sourceConfig.url, {
            params: { ac: "detail", wd: video.title },
            timeout: 5000,
            ...getAxiosConfig(),
          })

          const list = res.data?.list || []

          // 2. 调试：如果 API 返回空，说明资源站没这个片，或者 IP 被封了
          if (list.length === 0) {
            // 只有当连续大量出现这个日志时才需要担心
            console.warn(`⚠️ [无结果] 源: ${targetKey} | 片名: ${video.title}`)
            continue
          }

          // 3. 调试：如果有列表，但没匹配上，说明片名不一致
          // 这里我们稍微放宽一点匹配逻辑，打印出来看看差异
          const match = list.find((item) =>
            isLikelySameTitle(item.vod_name, video.title),
          )

          if (match) {
            video.sources.push({
              source_key: targetKey,
              vod_id: match.vod_id,
              vod_name: match.vod_name,
              vod_play_from: match.vod_play_from,
              vod_play_url: match.vod_play_url,
              remarks: match.vod_remarks,
            })
            isModified = true
            console.log(`✅ [匹配成功] ${video.title} 找到源: ${targetKey}`)
          } else {
            // 打印出不匹配的原因，帮助你排查
            // 比如数据库叫 "不死之身"，接口返回 "不死之身(2025)"
            console.log(
              `❌ [匹配失败] 数据库: "${video.title}" | 接口返回示例: "${list[0]?.vod_name}"`,
            )
          }
        } catch (innerErr) {
          // 4. 调试：网络报错
          console.error(
            `🔥 [请求报错] ${video.title} -> ${targetKey}: ${innerErr.message}`,
          )
        }
      }

      if (isModified) {
        await video.save()
        return 1
      }
      return 0
    } catch (videoErr) {
      console.error(`[Skip] 视频处理失败 ID: ${video._id}`, videoErr.message)
      return 0
    }
  })

  const results = await Promise.all(tasks)
  return results.reduce((a, b) => a + b, 0)
}

// ----------------------------------------------------------------
// 🐢 增量同步任务
// ----------------------------------------------------------------
exports.syncRecentUpdates = async (hours = 24) => {
  // ... (这部分代码没变，为了节省篇幅省略，保留你原来的即可) ...
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
        // 这里 processExternalItem 内部有 try-catch，但在循环外层最好也兜底
        try {
          const res = await processExternalItem(key, item)
          if (res === "updated") count++
        } catch (e) {
          // 忽略单条入库失败
        }
      }

      if (count > 0) {
        console.log(`✅ [${config.name}] 处理完毕: 新增/更新 ${count} 条`)
      } else {
        console.info(`👌 [${config.name}] 处理完毕: 无需更新`)
      }
    } catch (e) {
      console.error(`[${key}] 同步失败了`, e.message)
    }
  }
}
