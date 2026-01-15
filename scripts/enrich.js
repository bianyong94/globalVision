// scripts/enrich-task.js (豆瓣化深度清洗版)
const axios = require("axios")
const pLimit = require("p-limit")
const Video = require("../models/Video")

const TMDB_TOKEN = process.env.TMDB_TOKEN

// 不需要代理，Zeabur 直连
const tmdbApi = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  params: { language: "zh-CN" }, // 默认查中文
  timeout: 12000, // 稍微延长超时，因为数据量大了
})

const limit = pLimit(5) // 并发数

// 🛠️ 辅助：国家代码转中文 (简易版)
const COUNTRY_MAP = {
  US: "美国",
  GB: "英国",
  CN: "中国大陆",
  KR: "韩国",
  JP: "日本",
  HK: "中国香港",
  TW: "中国台湾",
  FR: "法国",
  DE: "德国",
  IN: "印度",
  TH: "泰国",
}

async function processBatch(videos) {
  const tasks = videos.map((video) => {
    return limit(async () => {
      try {
        // 🔥🔥🔥 新增：垃圾数据熔断机制 🔥🔥🔥
        const rawType = video.original_type || video.type || ""
        const rawTitle = video.title || ""

        // 如果原始分类或标题包含垃圾词，直接标记为 -1 (不匹配)，并退出
        if (
          /短剧|爽文|爽剧|反转|赘婿|战神|逆袭|重生|现代都市/.test(rawType) ||
          /短剧|爽文/.test(rawTitle)
        ) {
          // console.log(`跳过垃圾数据: ${rawTitle} (${rawType})`);
          return {
            updateOne: {
              filter: { _id: video._id },
              update: { $set: { tmdb_id: -1 } }, // 标记为垃圾，以后不再洗
            },
          }
        }
        // 1. 标题清洗 (保持不变)
        const cleanTitle = (video.title || "")
          .replace(/第[0-9一二三四五六七八九十]+[季部]/g, "")
          .replace(/S[0-9]+/i, "")
          .replace(/1080P|4K|HD|BD|中字|双语|国语|未删减|完整版/gi, "")
          .replace(/[\[\(].*?[\]\)]/g, "")
          .trim()

        if (!cleanTitle) return null

        // 2. 搜索
        const searchRes = await tmdbApi.get("/search/multi", {
          params: { query: cleanTitle },
        })
        if (!searchRes.data.results || searchRes.data.results.length === 0) {
          return {
            updateOne: {
              filter: { _id: video._id },
              update: { $set: { tmdb_id: -1 } },
            },
          }
        }
        const match = searchRes.data.results[0]

        // 3. 🔥🔥 获取深度详情 (关键步骤)
        // append_to_response: 一次性获取 演职员表(credits), 关键词(keywords)
        const detailRes = await tmdbApi.get(
          `/${match.media_type}/${match.id}`,
          {
            params: { append_to_response: "credits,keywords" },
          }
        )
        const details = detailRes.data

        // ================= 数据组装 (豆瓣风格) =================

        // A. 演职员表 (只取前几位，防止数据库太长)
        const directors =
          details.credits?.crew
            ?.filter((c) => c.job === "Director")
            .map((c) => c.name)
            .slice(0, 2)
            .join(",") || ""
        const writers =
          details.credits?.crew
            ?.filter((c) => c.department === "Writing")
            .map((c) => c.name)
            .slice(0, 2)
            .join(",") || ""
        const cast =
          details.credits?.cast
            ?.slice(0, 8)
            .map((c) => c.name)
            .join(",") || "" // 豆瓣通常显示前几位主演

        // B. 国家/地区
        let country = ""
        if (
          details.production_countries &&
          details.production_countries.length > 0
        ) {
          const code = details.production_countries[0].iso_3166_1
          country = COUNTRY_MAP[code] || details.production_countries[0].name
        }

        // C. 标签系统 (Genres + Keywords + Netflix识别)
        let newTags = video.tags ? [...video.tags] : []

        // C1. 基础类型 (动作, 剧情)
        if (details.genres) newTags.push(...details.genres.map((g) => g.name))

        // C2. 关键词 (小说改编, 穿越, 复仇) -> 这是豆瓣标签的精髓
        const keywordsRoot =
          details.keywords?.keywords || details.keywords?.results || []
        // TMDB关键词通常是英文，如果能接受英文标签最好，或者简单映射几个热门的
        // 这里直接存英文关键词，或者你可以接翻译API (为了性能暂不接)
        // 比如: "based on novel", "anime", "miniseries"
        // newTags.push(...keywordsRoot.map(k => k.name));

        // C3. 智能流媒体标 (Netflix, HBO)
        const companies = details.networks || details.production_companies || []
        const cNames = companies.map((c) => c.name.toLowerCase())
        if (cNames.some((n) => n.includes("netflix"))) newTags.push("netflix")
        if (cNames.some((n) => n.includes("hbo"))) newTags.push("hbo")
        if (cNames.some((n) => n.includes("disney"))) newTags.push("disney")
        if (cNames.some((n) => n.includes("apple"))) newTags.push("apple_tv")

        // 去重
        newTags = [...new Set(newTags)]

        // D. 分类修正
        let newCategory = video.category
        const protectedCats = ["anime", "variety", "sports", "doc"]
        if (!protectedCats.includes(newCategory)) {
          if (match.media_type === "tv") newCategory = "tv"
          if (match.media_type === "movie") newCategory = "movie"
        }

        // E. 年份与时长
        let newYear = video.year
        const releaseDate = match.release_date || match.first_air_date
        if (releaseDate) newYear = parseInt(releaseDate.substring(0, 4))

        const runtime =
          details.runtime ||
          (details.episode_run_time ? details.episode_run_time[0] : 0)

        // 返回更新指令
        return {
          updateOne: {
            filter: { _id: video._id },
            update: {
              $set: {
                // 核心标识
                tmdb_id: match.id,
                category: newCategory,

                // 视觉
                poster: match.poster_path
                  ? `https://image.tmdb.org/t/p/w500${match.poster_path}`
                  : video.poster,
                backdrop: match.backdrop_path
                  ? `https://image.tmdb.org/t/p/w780${match.backdrop_path}`
                  : "", // 横图

                // 文本资料
                title: match.title || match.name, // 使用官方中文名
                original_title: match.original_title || match.original_name, // 原名
                overview: match.overview || video.overview,

                // 豆瓣化字段
                rating: match.vote_average,
                director: directors,
                writer: writers,
                actors: cast, // 更新主演
                country: country,
                language: details.original_language,
                duration: runtime,
                year: newYear,
                tags: newTags,

                // 如果需要，可以把原 updateTime 更新一下，让它浮到最上面
                // updatedAt: new Date()
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

async function runEnrichTask(isFullScan = false) {
  if (!TMDB_TOKEN) {
    console.log("⚠️ TMDB_TOKEN Missing")
    return
  }
  console.log(`🚀 [TMDB深度清洗] 启动 (全量: ${isFullScan})`)

  // 全量模式跑 1000 轮 (20万条)，足够覆盖你的库
  const MAX_LOOPS = isFullScan ? 1000 : 5
  let loop = 0

  while (loop < MAX_LOOPS) {
    const count = await Video.countDocuments({ tmdb_id: { $exists: false } })
    if (count === 0) {
      console.log("✨ 全部清洗完毕")
      break
    }

    // 每次处理 100 条 (因为现在请求变重了，不仅查搜索还查详情，所以调小一点Batch)
    const videos = await Video.find({ tmdb_id: { $exists: false } })
      .select("title tags category overview poster year")
      .limit(100) // Batch Size 100

    if (videos.length === 0) break

    const bulkOps = await processBatch(videos)
    if (bulkOps.length > 0) {
      await Video.bulkWrite(bulkOps)
      console.log(`✅ [剩余:${count}] 已深度清洗 ${bulkOps.length} 条`)
    }
    loop++
    await new Promise((r) => setTimeout(r, 1500)) // 休息1.5秒
  }
}

module.exports = { runEnrichTask }
