// services/taskService.js
const axios = require("axios")
const Video = require("../models/Video")
const { sources } = require("../config/sources")
const { getAxiosConfig } = require("../utils/httpAgent")

// 🎯 配置：你需要去这三个网站（这里以 key 代表，需对应 sources.js 的配置）
const TARGET_SOURCES = ["feifan", "liangzi", "maotai"]

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

// 封装为导出函数
exports.runSupplementTask = async () => {
  console.log("⏰ [Cron] 开始执行定时补全任务...")
  const startTime = Date.now()

  try {
    // 1. 为了不阻塞服务器主线程，我们使用游标分批处理
    // 优化策略：可以只查询最近更新的视频，或者全量更新
    // 这里演示全量检查（如果数据量极大，建议改为只查 updatedAt 在 3 天内的）
    const cursor = Video.find({}).sort({ updatedAt: -1 }).cursor()

    let processed = 0
    let updated = 0

    for (
      let video = await cursor.next();
      video != null;
      video = await cursor.next()
    ) {
      processed++
      let isModified = false

      // 获取当前已有的源，防止重复
      const existingKeys = (video.sources || []).map((s) => s.source_key)

      // 遍历 3 个目标网站
      for (const targetKey of TARGET_SOURCES) {
        // 🛡️ 判断逻辑 1: 如果数据库里已经有这个源了，直接跳过，节省请求
        if (existingKeys.includes(targetKey)) continue

        const sourceConfig = sources[targetKey]
        if (!sourceConfig) continue

        try {
          // 请求资源站接口 (搜索同名资源)
          // 注意：为了防止被对方防火墙屏蔽，建议每次请求间隔几百毫秒（这里暂不加，由 await 自然延迟）
          const res = await axios.get(sourceConfig.url, {
            params: { ac: "detail", wd: video.title },
            timeout: 5000,
            ...getAxiosConfig(),
          })

          const list = res.data?.list || []

          // 🛡️ 判断逻辑 2: 严格名称匹配
          const match = list.find((item) =>
            isLikelySameTitle(item.vod_name, video.title),
          )

          if (match) {
            // 找到了新源，加入数据库
            video.sources.push({
              source_key: targetKey,
              vod_id: String(match.vod_id || ""),
              vod_name: match.vod_name || video.title,
              vod_play_from: match.vod_play_from || "",
              vod_play_url: match.vod_play_url,
              remarks: match.vod_remarks,
              updatedAt: new Date(),
            })
            isModified = true
            console.log(
              `   [Cron] ${video.title} -> 新增源: ${sourceConfig.name}`,
            )
          }
        } catch (e) {
          // 单个源报错忽略，继续下一个
          // console.warn(`   搜索失败: ${targetKey} - ${e.message}`)
        }
      }

      // 只有数据变动了才保存
      if (isModified) {
        await video.save()
        updated++
      }

      // 每一百条打印一次进度
      if (processed % 100 === 0) {
        console.log(`   [Cron] 进度: 已扫描 ${processed} 条...`)
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(
      `✅ [Cron] 任务完成! 耗时 ${duration}秒, 扫描 ${processed} 条, 更新 ${updated} 条`,
    )
  } catch (error) {
    console.error("❌ [Cron] 任务执行出错:", error)
  }
}
