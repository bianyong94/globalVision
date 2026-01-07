// scripts/sync_maotai.js
require("dotenv").config()
const mongoose = require("mongoose")
const axios = require("axios")
const Video = require("../models/Video")
const { classifyVideo } = require("../utils/classifier")

const API_URL =
  "https://caiji.maotaizy.cc/api.php/provide/vod/from/mtm3u8/at/json/"
const SOURCE_KEY = "maotai"

const fetchPage = async (pg, hours) => {
  // 设置更长的超时时间 15s
  const res = await axios.get(API_URL, {
    params: { ac: "detail", h: hours, pg: pg },
    timeout: 15000,
  })
  return res.data
}

const transformData = (item) => {
  const result = classifyVideo(item)

  // 🛑 如果被黑名单拦截，返回 null
  if (!result) return null

  const { category, tags } = result

  return {
    uniq_id: `${SOURCE_KEY}_${item.vod_id}`,
    vod_id: item.vod_id,
    source: SOURCE_KEY,
    title: item.vod_name,
    director: item.vod_director,
    actors: item.vod_actor,
    original_type: item.type_name,
    category: category,
    tags: tags,
    poster: item.vod_pic,
    overview: (item.vod_content || "")
      .replace(/<[^>]+>/g, "")
      .substring(0, 500),
    language: item.vod_lang, // 如果之前改了 Schema，这里要注意字段名
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

const syncTask = async (hours = 24) => {
  console.log(`🚀 [${new Date().toISOString()}] Start Syncing ${SOURCE_KEY}...`)

  let page = 3200
  let totalPage = 1
  let processedCount = 0
  let errorCount = 0 // 连续错误计数

  do {
    try {
      // 1. 请求数据
      const data = await fetchPage(page, hours)

      // 2. 检查数据有效性
      if (!data || !data.list || data.list.length === 0) {
        console.log(`⚠️ Page ${page} is empty or end of list.`)
        break
      }

      totalPage = data.pagecount

      // 3. 数据清洗与转换
      const operations = data.list
        .map((item) => transformData(item)) // 清洗
        .filter((item) => item !== null) // 过滤掉被屏蔽的 null
        .map((doc) => ({
          updateOne: {
            filter: { uniq_id: doc.uniq_id },
            update: { $set: doc },
            upsert: true,
          },
        }))

      // 4. 批量写入 (只有当有有效数据时才写入)
      if (operations.length > 0) {
        await Video.bulkWrite(operations)
        processedCount += operations.length
        console.log(
          `✅ Page ${page}/${totalPage} saved (${operations.length} items).`
        )
      } else {
        console.log(
          `⚠️ Page ${page}/${totalPage} skipped (all items filtered).`
        )
      }

      // 重置连续错误计数
      errorCount = 0
      page++
    } catch (error) {
      console.error(`❌ Error on page ${page}: ${error.message}`)
      errorCount++

      // 如果连续错误超过 10 次，可能是源站挂了，停止任务防止死循环
      if (errorCount > 10) {
        console.error("🔥 Too many errors, stopping sync task.")
        break
      }

      // 遇到错误，等待 3 秒后重试下一页 (跳过当前页，或者你可以选择不 page++ 来重试当前页)
      // 这里选择 page++ 跳过坏页，防止卡死
      console.log("⏳ Waiting 3s before next page...")
      await new Promise((r) => setTimeout(r, 3000))
      page++
    }
  } while (page <= totalPage)

  console.log(`🎉 Sync Complete! Total processed: ${processedCount}`)
}

// ... 底部启动代码保持不变 ...
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI missing")
    process.exit(1)
  }
  mongoose.connect(MONGO_URI).then(async () => {
    await syncTask(24)
    process.exit(0)
  })
}

module.exports = { syncTask }
