require("dotenv").config()
const mongoose = require("mongoose")
const axios = require("axios")
const Video = require("../models/Video")
const { sources } = require("../config/sources")
const { getAxiosConfig } = require("../utils/httpAgent")

// ==========================================
// 🛡️ 安全配置
// ==========================================
const TARGET_SOURCES = ["feifan", "liangzi"] // 要补全的源
const DRY_RUN = false // ⚠️ 设为 true 则只打印不保存；设为 false 则真实写入数据库

async function supplement() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log(
    `✅ DB Connected. Mode: ${DRY_RUN ? "🔍 DRY RUN (只读)" : "⚡ LIVE (写入)"}`,
  )

  // 游标遍历，防止内存溢出
  const cursor = Video.find({}).cursor()

  let processed = 0
  let updated = 0

  for (
    let video = await cursor.next();
    video != null;
    video = await cursor.next()
  ) {
    processed++
    let isModified = false

    // 提取当前已有的源标识，例如 ['maotai']
    // 这一步确保了不会重复添加同一个源
    const existingKeys = video.sources.map((s) => s.source_key)

    process.stdout.write(
      `\r[${processed}] Processing: ${video.title.substring(0, 20)}... `,
    )

    for (const targetKey of TARGET_SOURCES) {
      // 🛡️ 防重检查 1: 如果已经有了这个源，跳过
      if (existingKeys.includes(targetKey)) continue

      const sourceConfig = sources[targetKey]
      if (!sourceConfig) continue

      try {
        // 请求资源站接口
        const res = await axios.get(sourceConfig.url, {
          params: { ac: "detail", wd: video.title },
          timeout: 3000, // 超时跳过，不卡死
          ...getAxiosConfig(),
        })

        const list = res.data?.list || []

        // 🛡️ 防错检查 2: 严格全等匹配
        // 只有 "钢铁侠" === "钢铁侠" 才算，"钢铁侠2" 不算
        const match = list.find((item) => item.vod_name === video.title)

        if (match) {
          // 找到了！准备添加
          const newSource = {
            source_key: targetKey,
            source_name: sourceConfig.name,
            vod_play_url: match.vod_play_url,
            remarks: match.vod_remarks,
          }

          if (DRY_RUN) {
            console.log(
              `\n   🔍 [DRY-RUN] Would add ${targetKey} to ${video.title}`,
            )
          } else {
            video.sources.push(newSource)
            isModified = true
            console.log(`\n   ➕ Added ${sourceConfig.name}`)
          }
        }
      } catch (e) {
        // 网络错误忽略，继续下一个
      }
    }

    // 只有真正有修改时才保存数据库
    if (isModified && !DRY_RUN) {
      await video.save()
      updated++
    }
  }

  console.log(`\n\n🎉 Done! Processed: ${processed}, Updated: ${updated}`)
  process.exit()
}

supplement()
