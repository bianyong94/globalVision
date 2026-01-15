// scripts/enrich-task.js (建议改个名放在 scripts 目录下)
const axios = require("axios")
const pLimit = require("p-limit")
const Video = require("../models/Video") // 👈 确保路径指向你的 models/Video.js

// ⚠️ 从环境变量获取 Token，不要写死
const TMDB_TOKEN = process.env.TMDB_TOKEN

// Zeabur 在海外，不需要代理！
const tmdbApi = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  params: { language: "zh-CN" },
  timeout: 10000,
})

// 并发数：Zeabur 容器性能有限，建议保守一点，设为 5
const limit = pLimit(5)
const BATCH_SIZE = 200 // 每次处理 200 条

// 核心处理函数（单批次）
async function processBatch(videos) {
  const tasks = videos.map((video) => {
    return limit(async () => {
      try {
        // 1. 标题清洗
        const cleanTitle = (video.title || "")
          .replace(/第[0-9一二三四五六七八九十]+[季部]/g, "")
          .replace(/S[0-9]+/i, "")
          .replace(/1080P|4K|HD|BD|中字|双语|国语/gi, "")
          .replace(/[\[\(].*?[\]\)]/g, "")
          .trim()

        if (!cleanTitle) return null

        // 2. 搜索
        const searchRes = await tmdbApi.get("/search/multi", {
          params: { query: cleanTitle },
        })

        if (!searchRes.data.results || searchRes.data.results.length === 0) {
          // 没搜到标记 -1
          return {
            updateOne: {
              filter: { _id: video._id },
              update: { $set: { tmdb_id: -1 } },
            },
          }
        }

        const match = searchRes.data.results[0]

        // 3. 详情
        const detailRes = await tmdbApi.get(`/${match.media_type}/${match.id}`)
        const details = detailRes.data

        // 4. 组装数据
        let newTags = video.tags ? [...video.tags] : []
        let newCategory = video.category

        // 保护特殊分类
        const protectedCats = ["anime", "variety", "sports", "doc"]
        if (!protectedCats.includes(newCategory)) {
          if (match.media_type === "tv") newCategory = "tv"
          if (match.media_type === "movie") newCategory = "movie"
        }

        // 标签
        const companies = details.networks || details.production_companies || []
        const cNames = companies.map((c) => c.name.toLowerCase())
        if (cNames.some((n) => n.includes("netflix"))) newTags.push("netflix")
        if (cNames.some((n) => n.includes("hbo"))) newTags.push("hbo")
        if (cNames.some((n) => n.includes("disney"))) newTags.push("disney")
        if (cNames.some((n) => n.includes("apple"))) newTags.push("apple_tv")
        if (details.genres) newTags.push(...details.genres.map((g) => g.name))
        newTags = [...new Set(newTags)]

        // 年份
        let newYear = video.year
        const releaseDate = match.release_date || match.first_air_date
        if (releaseDate) newYear = parseInt(releaseDate.substring(0, 4))

        return {
          updateOne: {
            filter: { _id: video._id },
            update: {
              $set: {
                category: newCategory,
                rating: match.vote_average,
                overview: match.overview || video.overview,
                tmdb_id: match.id,
                poster: match.poster_path
                  ? `https://image.tmdb.org/t/p/w500${match.poster_path}`
                  : video.poster,
                tags: newTags,
                year: newYear,
              },
            },
          },
        }
      } catch (e) {
        return null
      }
    })
  })

  const results = await Promise.all(tasks)
  return results.filter((r) => r !== null)
}

// 导出主任务函数
// isFullScan: true 表示全量跑（死循环直到跑完），false 表示只跑一轮（适合定时任务）
async function runEnrichTask(isFullScan = false) {
  if (!TMDB_TOKEN) {
    console.log("⚠️ 未配置 TMDB_TOKEN，跳过清洗任务")
    return
  }

  console.log(
    `🚀 [TMDB清洗] 任务启动 (模式: ${isFullScan ? "全量循环" : "单轮增量"})`
  )

  let loopCount = 0
  // 防止死循环太久占用资源，全量模式最多跑 500 轮 (约 10万条)
  const MAX_LOOPS = isFullScan ? 500 : 5

  while (loopCount < MAX_LOOPS) {
    // 查找未清洗的数据
    const count = await Video.countDocuments({ tmdb_id: { $exists: false } })
    if (count === 0) {
      console.log("✨ [TMDB清洗] 所有数据已处理完毕！")
      break
    }

    console.log(
      `📦 [TMDB清洗] 剩余 ${count} 条，正在处理第 ${loopCount + 1} 批...`
    )

    const videos = await Video.find({ tmdb_id: { $exists: false } })
      .select("title tags category overview poster year")
      .limit(BATCH_SIZE)

    if (videos.length === 0) break

    const bulkOps = await processBatch(videos)

    if (bulkOps.length > 0) {
      await Video.bulkWrite(bulkOps)
      console.log(`✅ [TMDB清洗] 更新成功: ${bulkOps.length} 条`)
    }

    loopCount++

    // 稍微休息一下，避免 CPU 飙升
    await new Promise((r) => setTimeout(r, 2000))
  }
}

module.exports = { runEnrichTask }
