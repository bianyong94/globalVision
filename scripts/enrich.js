require("dotenv").config()
const axios = require("axios")
const pLimit = require("p-limit")
const Video = require("../models/Video")

// ==========================================
// 1. 配置
// ==========================================
const TMDB_TOKEN = process.env.TMDB_TOKEN
if (!TMDB_TOKEN) {
  console.error("❌ 环境变量 TMDB_TOKEN 未配置")
  process.exit(1)
}

const tmdbApi = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  params: { language: "zh-CN" },
  timeout: 10000,
})

// 并发数
const limit = pLimit(20)

// 流媒体平台 ID 映射 (TMDB 标准 ID)
const PROVIDER_IDS = {
  8: "Netflix",
  337: "Disney+",
  350: "Apple TV+",
  119: "Amazon Prime", // 很多 HBO 剧在 Amazon
  283: "Crunchyroll", // 动漫
  // HBO Max (ID 变化较多，通常通过 Network 识别更准)
}

// ==========================================
// 2. 校验与兜底逻辑
// ==========================================
function isYearSafe(localYear, tmdbDateStr) {
  if (!localYear || localYear === 0) return true
  if (!tmdbDateStr) return false
  const tmdbYear = parseInt(tmdbDateStr.substring(0, 4))
  return Math.abs(localYear - tmdbYear) <= 1
}

async function markAsDone(id) {
  try {
    await Video.updateOne({ _id: id }, { $set: { is_enriched: true } })
  } catch (e) {}
}

async function markAsIgnored(id) {
  try {
    await Video.updateOne(
      { _id: id },
      { $set: { is_enriched: true }, $unset: { tmdb_id: "" } },
    )
  } catch (e) {}
}

async function keepOldOrIgnore(video, reason = "") {
  if (video.tmdb_id && video.tmdb_id !== -1) {
    await markAsDone(video._id)
  } else {
    await markAsIgnored(video._id)
  }
}

// ==========================================
// 3. 单条清洗逻辑
// ==========================================
async function enrichSingleVideo(video) {
  const rawTitle = video.title || ""

  try {
    // 垃圾熔断
    if (/短剧|爽文|写真|福利/.test(rawTitle)) {
      await markAsIgnored(video._id)
      return
    }

    const cleanTitle = rawTitle
      .replace(/第[0-9一二三四五六七八九十]+[季部]/g, "")
      .replace(/S[0-9]+/i, "")
      .replace(/1080P|4K|HD|BD|中字|双语|国语|未删减|完整版|蓝光/gi, "")
      .replace(/[\[\(（].*?[\]\)）]/g, "")
      .trim()

    if (!cleanTitle) {
      await keepOldOrIgnore(video)
      return
    }

    // 搜索
    const searchRes = await tmdbApi.get("/search/multi", {
      params: { query: cleanTitle },
    })

    const results = searchRes.data.results || []
    if (results.length === 0) {
      await keepOldOrIgnore(video)
      return
    }

    // 匹配
    let bestMatch = null
    const localYear = video.year

    for (const item of results) {
      let isLocalMovie = video.category === "movie"
      let isLocalTv = ["tv", "anime", "variety"].includes(video.category)

      const tmdbTitle = item.title || item.name
      const isTitleExact = tmdbTitle === cleanTitle

      if (!isTitleExact) {
        if (isLocalMovie && item.media_type !== "movie") continue
        if (isLocalTv && item.media_type !== "tv") continue
      }

      const releaseDate = item.release_date || item.first_air_date
      if (!releaseDate) continue
      const tmdbYear = parseInt(releaseDate.substring(0, 4))

      let isYearMatch = false
      if (!localYear || localYear === 0) isYearMatch = true
      else if (item.media_type === "movie") {
        if (Math.abs(localYear - tmdbYear) <= 2) isYearMatch = true
      } else if (item.media_type === "tv") {
        if (localYear >= tmdbYear - 1) isYearMatch = true
      }

      if (isTitleExact && isYearMatch) {
        bestMatch = item
        break
      }
      if (!bestMatch && isYearMatch) {
        bestMatch = item
      }
    }

    if (!bestMatch) {
      // 兜底：尝试完全匹配标题
      bestMatch = results.find(
        (item) => (item.title || item.name) === cleanTitle,
      )
    }

    if (!bestMatch) {
      await keepOldOrIgnore(video)
      return
    }

    // 🔥🔥 获取详情 (包含 watch/providers)
    const detailRes = await tmdbApi.get(
      `/${bestMatch.media_type}/${bestMatch.id}`,
      {
        params: {
          // 关键：请求 networks (出品方) 和 watch/providers (播放渠道)
          append_to_response:
            "credits,keywords,networks,production_companies,watch/providers",
        },
      },
    )

    const updateData = buildUpdateData(video, bestMatch, detailRes.data)
    await applyUpdateWithMerge(video, updateData)
  } catch (error) {
    await markAsDone(video._id)
  }
}

// ==========================================
// 4. 数据组装 (智能标签核心)
// ==========================================
function buildUpdateData(localVideo, match, details) {
  const directors =
    details.credits?.crew
      ?.filter((c) => c.job === "Director")
      .map((c) => c.name)
      .slice(0, 3)
      .join(",") || ""
  const cast =
    details.credits?.cast
      ?.slice(0, 10)
      .map((c) => c.name)
      .join(",") || ""
  let country = details.production_countries?.[0]?.name || ""

  let newTags = localVideo.tags ? [...localVideo.tags] : []
  if (details.genres) newTags.push(...details.genres.map((g) => g.name))

  // -------------------------------------------------------------
  // 🔥🔥🔥 智能流媒体识别逻辑 (自动打标) 🔥🔥🔥
  // -------------------------------------------------------------

  // 1. 检查出品方 (Networks / Companies) -> 识别“原创剧”
  // 比如 Stranger Things 的 network 是 Netflix
  const companies = [
    ...(details.networks || []),
    ...(details.production_companies || []),
  ]
  const cNames = companies.map((c) => c.name.toLowerCase())

  if (cNames.some((n) => n.includes("netflix"))) newTags.push("Netflix")
  if (cNames.some((n) => n.includes("hbo"))) newTags.push("HBO")
  if (cNames.some((n) => n.includes("disney"))) newTags.push("Disney+")
  if (cNames.some((n) => n.includes("apple"))) newTags.push("Apple TV+")

  // 2. 检查播放渠道 (Watch Providers) -> 识别“独家播放/分销”
  // TMDB 会返回全球各地的播放源信息
  const providersObj = details["watch/providers"]?.results || {}

  // 我们主要检查 'US' (发源地) 和 'TW' (亚洲区) 的 flatrate (会员订阅)
  const targetRegions = ["US", "TW", "KR", "JP"]
  const providerSet = new Set()

  targetRegions.forEach((region) => {
    const regionData = providersObj[region]
    if (regionData && regionData.flatrate) {
      regionData.flatrate.forEach((p) => {
        if (PROVIDER_IDS[p.provider_id]) {
          providerSet.add(PROVIDER_IDS[p.provider_id])
        }
      })
    }
  })

  // 将识别到的 Provider 加入标签
  providerSet.forEach((p) => newTags.push(p))

  // -------------------------------------------------------------

  return {
    tmdb_id: match.id,
    title: match.title || match.name,
    original_title: match.original_title || match.original_name,
    overview: match.overview || localVideo.overview,
    poster: match.poster_path
      ? `https://image.tmdb.org/t/p/w500${match.poster_path}`
      : localVideo.poster,
    backdrop: match.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${match.backdrop_path}`
      : "",
    rating: match.vote_average,
    vote_count: match.vote_count,
    year:
      parseInt(
        (match.release_date || match.first_air_date || "").substring(0, 4),
      ) || localVideo.year,
    category: match.media_type === "movie" ? "movie" : "tv",
    director: directors,
    actors: cast,
    country: country,
    language: details.original_language,
    tags: [...new Set(newTags)], // 去重
    is_enriched: true,
  }
}

async function applyUpdateWithMerge(currentVideo, updateData) {
  try {
    await Video.updateOne({ _id: currentVideo._id }, { $set: updateData })
  } catch (error) {
    if (error.code === 11000) {
      const existingVideo = await Video.findOne({ tmdb_id: updateData.tmdb_id })
      if (
        existingVideo &&
        existingVideo._id.toString() !== currentVideo._id.toString()
      ) {
        let isModified = false
        for (const s of currentVideo.sources) {
          const exists = existingVideo.sources.some(
            (es) => es.source_key === s.source_key && es.vod_id === s.vod_id,
          )
          if (!exists) {
            existingVideo.sources.push(s)
            isModified = true
          }
        }
        if (isModified) {
          existingVideo.updatedAt = new Date()
          await existingVideo.save()
        }
        await Video.deleteOne({ _id: currentVideo._id })
      }
    } else {
      await markAsDone(currentVideo._id)
    }
  }
}

// 主程序
async function runEnrichTask(isFullScan = false) {
  console.log(`🚀 [TMDB智能清洗] 启动 (并发20)...`)

  const query = { is_enriched: false }
  let totalLeft = await Video.countDocuments(query)
  const totalStart = totalLeft
  console.log(`📊 待处理: ${totalStart} 条`)

  if (totalLeft === 0) return

  const BATCH_SIZE = 500

  while (totalLeft > 0) {
    try {
      const batchDocs = await Video.find(query)
        .select("_id title year category tags sources tmdb_id overview poster")
        .limit(BATCH_SIZE)
        .lean()

      if (batchDocs.length === 0) break

      const promises = batchDocs.map((doc) =>
        limit(() => enrichSingleVideo(doc)),
      )
      await Promise.all(promises)

      const newTotalLeft = await Video.countDocuments(query)
      if (newTotalLeft === totalLeft) {
        console.log("⚠️ 进度停止，防死循环退出")
        break
      }
      totalLeft = newTotalLeft
      console.log(`⚡ 剩余: ${totalLeft}`)
    } catch (err) {
      console.error(`💥 批次出错: ${err.message}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  console.log("✅ 结束")
}

if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI
  const mongoose = require("mongoose")
  mongoose.connect(MONGO_URI).then(async () => {
    await runEnrichTask(true)
    process.exit(0)
  })
}

module.exports = { runEnrichTask }
