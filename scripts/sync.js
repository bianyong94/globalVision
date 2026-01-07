// scripts/sync_maotai.js
require("dotenv").config()
const mongoose = require("mongoose")
const axios = require("axios")
const Video = require("../models/Video")
const { classifyVideo } = require("../utils/classifier")

// 茅台资源 JSON 接口 (确保是 json 结尾)
const API_URL =
  "https://caiji.maotaizy.cc/api.php/provide/vod/from/mtm3u8/at/json/"
const SOURCE_KEY = "maotai" // 源标识

// 采集单页数据
const fetchPage = async (pg, hours) => {
  try {
    const res = await axios.get(API_URL, {
      params: {
        ac: "detail",
        h: hours, // 采集最近几小时
        pg: pg,
      },
      timeout: 10000, // 防止卡死
    })
    return res.data
  } catch (error) {
    console.error(`❌ Page ${pg} fetch failed: ${error.message}`)
    return null
  }
}

// 转换数据格式
const transformData = (item) => {
  const { category, tags } = classifyVideo(item)

  return {
    uniq_id: `${SOURCE_KEY}_${item.vod_id}`,
    vod_id: item.vod_id,
    source: SOURCE_KEY,

    title: item.vod_name,
    director: item.vod_director,
    actors: item.vod_actor,
    original_type: item.type_name,

    category: category, // ✅ 标准分类
    tags: tags, // ✅ 智能标签

    poster: item.vod_pic,
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

// 主任务
const syncTask = async (hours = 24) => {
  console.log(`🚀 [${new Date().toISOString()}] Start Syncing ${SOURCE_KEY}...`)

  let page = 1
  let totalPage = 1
  let processedCount = 0

  do {
    const data = await fetchPage(page, hours)
    if (!data || !data.list || data.list.length === 0) break

    totalPage = data.pagecount

    // 构造批量写入操作 (BulkWrite)
    const operations = data.list.map((item) => {
      const doc = transformData(item)
      return {
        updateOne: {
          filter: { uniq_id: doc.uniq_id }, // 根据唯一ID查找
          update: { $set: doc }, // 更新所有字段
          upsert: true, // 不存在则插入
        },
      }
    })

    if (operations.length > 0) {
      await Video.bulkWrite(operations)
      processedCount += operations.length
      console.log(
        `✅ Page ${page}/${totalPage} processed (${operations.length} items)`
      )
    }

    page++

    // 简单的限流，防止被封 IP
    // await new Promise(r => setTimeout(r, 100));
  } while (page <= totalPage)

  console.log(`🎉 Sync Complete! Total processed: ${processedCount}`)
}

// 如果直接运行此文件 (node scripts/sync_maotai.js)
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI is missing in .env")
    process.exit(1)
  }

  mongoose
    .connect(MONGO_URI)
    .then(async () => {
      console.log("🔥 DB Connected")
      // 首次建议跑全量: syncTask(99999)
      // 日常跑增量: syncTask(24)
      await syncTask(24)
      process.exit(0)
    })
    .catch((err) => {
      console.error("DB Error", err)
      process.exit(1)
    })
}

module.exports = { syncTask }
