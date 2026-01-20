require("dotenv").config()
const axios = require("axios")
const mongoose = require("mongoose")
const Video = require("../models/Video")
// 引入代理库
const { HttpsProxyAgent } = require("https-proxy-agent")

const TMDB_TOKEN = process.env.TMDB_TOKEN

// 🔥🔥🔥 核心修改：配置本地代理 🔥🔥🔥
// 这里的端口 7890 请根据你自己的代理软件修改 (Clash通常是7890或7897)
const agent = new HttpsProxyAgent("http://127.0.0.1:7897")

const tmdbApi = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  params: { language: "zh-CN" },
  timeout: 15000,
  // 挂载代理
  httpsAgent: agent,
  proxy: false, // 必须显式关闭 axios 默认代理，否则 agent 不生效
})

async function debugOne(keyword) {
  // 1. 在数据库里找这条数据
  const video = await Video.findOne({ title: new RegExp(keyword) })
  if (!video) {
    console.log("❌ 数据库里没找到这个片子")
    return
  }

  console.log("\n========================================")
  console.log(`🎬 目标影片: ${video.title}`)
  console.log(`📅 本地年份: ${video.year}`)
  console.log(`🏷️ 本地分类: ${video.category}`)
  console.log("========================================\n")

  // 2. 模拟清洗标题
  const cleanTitle = video.title
    .replace(/第[0-9一二三四五六七八九十]+[季部]/g, "")
    .replace(/S[0-9]+/i, "")
    .replace(/1080P|4K|HD|BD|中字|双语|国语|未删减|完整版|蓝光/gi, "")
    .replace(/[\[\(（].*?[\]\)）]/g, "")
    .trim()

  console.log(`🧹 清洗后标题: "${cleanTitle}"`)

  // 3. 去 TMDB 搜索
  try {
    const searchRes = await tmdbApi.get("/search/multi", {
      params: { query: cleanTitle },
    })
    const results = searchRes.data.results || []

    console.log(`🔍 TMDB 返回结果数: ${results.length}`)

    if (results.length === 0) {
      console.log("❌ TMDB 没搜到任何结果，所以保留了原数据 (0分)")
      return
    }

    // 4. 模拟匹配逻辑
    console.log("\n--- 开始匹配尝试 ---")
    let matched = false

    for (const item of results) {
      const tmdbName = item.title || item.name
      const date = item.release_date || item.first_air_date
      const year = date ? parseInt(date.substring(0, 4)) : 0
      const type = item.media_type

      console.log(`候选: [${type}] ${tmdbName} (${year})`)

      // 检查类型
      let isLocalMovie = video.category === "movie"
      let isLocalTv = ["tv", "anime", "variety"].includes(video.category)
      let typeMatch = true
      if (isLocalMovie && type !== "movie") typeMatch = false
      if (isLocalTv && type !== "tv") typeMatch = false

      // 检查年份
      let yearMatch = true
      if (video.year && video.year > 0 && Math.abs(video.year - year) > 1)
        yearMatch = false

      console.log(`   -> 类型匹配: ${typeMatch ? "✅" : "❌"}`)
      console.log(
        `   -> 年份匹配: ${yearMatch ? "✅" : "❌"} (本地:${video.year} vs TMDB:${year})`,
      )

      if (typeMatch && yearMatch) {
        console.log(`🎉 匹配成功！应该更新为 -> 评分: ${item.vote_average}`)
        matched = true

        // 检查详情里的标签
        const detailRes = await tmdbApi.get(`/${item.media_type}/${item.id}`, {
          params: {
            append_to_response:
              "credits,keywords,networks,production_companies",
          },
        })
        const companies = [
          ...(detailRes.data.networks || []),
          ...(detailRes.data.production_companies || []),
        ]
        const isNetflix = companies.some((c) =>
          c.name.toLowerCase().includes("netflix"),
        )
        console.log(`   -> Netflix标签: ${isNetflix ? "有" : "无"}`)

        break // 模拟脚本逻辑，匹配到一个就停
      }
    }

    if (!matched) {
      console.log("\n❌ 所有候选都未通过校验，触发兜底策略 (保留原数据 0分)")
    }
  } catch (e) {
    console.error("请求报错:", e.message)
  }
}

mongoose.connect(process.env.MONGO_URI).then(async () => {
  // 🔥 改这里：输入一个你数据库里评分是0，但你觉得应该有分的电影名
  await debugOne("怪奇物语 第三季")
  process.exit(0)
})
