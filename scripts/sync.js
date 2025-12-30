// scripts/sync.js
require("dotenv").config()
const mongoose = require("mongoose")
const axios = require("axios")
const Video = require("../models/Video")
const { sources } = require("../config/sources")

// 延时函数，防止请求太快被封
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

mongoose.connect(process.env.MONGO_URI).then(() => {
  console.log("🔥 DB Connected, Ready to Sync...")
  startSync()
})

const formatVideo = (item, sourceKey) => {
  // ... (保持之前的 formatVideo 代码不变) ...
  return {
    id: `${sourceKey}$${item.vod_id}`,
    title: item.vod_name,
    type: item.type_name,
    // 🔴 新增：保存分类ID (转为数字类型)
    type_id: parseInt(item.type_id) || 0,
    poster: item.vod_pic,
    remarks: item.vod_remarks,
    year: item.vod_year,
    rating: parseFloat(item.vod_score) || 0,
    date: item.vod_time,
    actors: item.vod_actor || "",
    director: item.vod_director || "",
    // overview: (item.vod_content || "").replace(/<[^>]+>/g, "").trim(),
    vod_play_from: item.vod_play_from,
    vod_play_url: item.vod_play_url,
    updatedAt: new Date(),
  }
}

// hours = 0 代表采集所有历史数据
async function syncSource(sourceKey, hours = 0,startPage = 1) {
  const source = sources[sourceKey]
  if (!source) return

  console.log(`\n🚀 开始采集源: [${source.name}]`)
  console.log(
    `   模式: ${
      hours === 0 ? "全量采集 (历史所有)" : `增量采集 (最近 ${hours} 小时)`
    }`
  )

  let page = startPage
  let totalSaved = 0

  while (true) {
    try {
      const url = source.url
      const params = {
        ac: "detail",
        at: "json",
        pg: page,
      }

      // 只有当 hours > 0 时才传 h 参数
      if (hours > 0) {
        params.h = hours
      }

      console.log(`   📡 正在请求第 ${page} 页...`)

      // 请求数据 (超时时间设长一点)
      const res = await axios.get(url, { params, timeout: 60000 })
      const list = res.data.list

      // 如果列表为空，说明采完了
      if (!list || list.length === 0) {
        console.log("   ✅ 数据为空，采集结束")
        break
      }

      // 批量写入
      const bulkOps = list.map((item) => {
        const videoData = formatVideo(item, sourceKey)
        return {
          updateOne: {
            filter: { id: videoData.id },
            update: { $set: videoData },
            upsert: true,
          },
        }
      })

      await Video.bulkWrite(bulkOps)
      totalSaved += list.length
      process.stdout.write(
        `   💾 本页入库 ${list.length} 条 | 总计: ${totalSaved} 条\r`
      )

      // 关键：如果这页数据少于20条，说明是最后一页了 (通常一页20条)
      if (list.length < 20) {
        console.log("\n   🏁 已到达最后一页")
        break
      }

      page++

      // 🟢 关键：每页休息 1-2 秒，保护对方服务器，也保护你不被封
      await sleep(1500)
    } catch (e) {
      console.error(`\n   ❌ 第 ${page} 页出错: ${e.message}`)
      console.log("   🔄 尝试休息 5 秒后重试此页...")
      await sleep(5000)
      // 这里不 index++，继续重试当前页
    }
  }
}

async function startSync() {
  // 🟢 第一次初始化：采集茅台所有历史数据 (hours = 0)
  await syncSource("maotai", 0, 1)

  // 如果你想采其他源，也可以解开：
  // await syncSource("sony", 0);

  console.log("\n🎉 所有任务完成")
  process.exit(0)
}
