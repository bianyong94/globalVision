require("dotenv").config()
const axios = require("axios")
const pLimit = require("p-limit")
const Video = require("../models/Video")

// ==========================================
// 1. 配置：火力全开
// ==========================================
const TMDB_TOKEN = process.env.TMDB_TOKEN

// 🔥 核心修改 1：提高并发到 20 (如果报错 429 太多，可降回 10)
const CONCURRENCY = 20
const limit = pLimit(CONCURRENCY)

const tmdbApi = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  params: { language: "zh-CN" },
  timeout: 10000,
})

// 🔥 核心修改 2：增加 Axios 拦截器处理限流 (429)
tmdbApi.interceptors.response.use(null, async (error) => {
  if (error.response && error.response.status === 429) {
    // console.log("🚦 触发限流，休息 2秒...");
    await new Promise((r) => setTimeout(r, 2000))
    // 重试请求
    return tmdbApi.request(error.config)
  }
  return Promise.reject(error)
})

// ... (校验逻辑保持不变)
function isYearSafe(localYear, tmdbDateStr) {
  if (!localYear || localYear === 0) return true
  if (!tmdbDateStr) return false
  const tmdbYear = parseInt(tmdbDateStr.substring(0, 4))
  return Math.abs(localYear - tmdbYear) <= 1
}

// ... (状态标记函数保持不变)
async function markAsDone(id) {
  try {
    await Video.updateOne({ _id: id }, { $set: { is_enriched: true } })
  } catch (e) {}
}

async function markAsIgnored(id) {
  try {
    await Video.updateOne(
      { _id: id },
      { $set: { is_enriched: true }, $unset: { tmdb_id: "" } }
    )
  } catch (e) {}
}

// ==========================================
// 3. 单条清洗逻辑 (逻辑不变，速度优化)
// ==========================================
async function enrichSingleVideo(video) {
  const rawTitle = video.title || ""

  try {
    // 快速熔断
    if (/短剧|爽文|爽剧|反转|赘婿|战神|逆袭|重生|写真|福利/.test(rawTitle)) {
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
      await markAsDone(video._id)
      return
    }

    const searchRes = await tmdbApi.get("/search/multi", {
      params: { query: cleanTitle },
    })

    const results = searchRes.data.results || []
    if (results.length === 0) {
      await markAsDone(video._id)
      return
    }

    let bestMatch = null
    for (const item of results) {
      let isLocalMovie = video.category === "movie"
      let isLocalTv = ["tv", "anime", "variety"].includes(video.category)
      if (isLocalMovie && item.media_type !== "movie") continue
      if (isLocalTv && item.media_type !== "tv") continue

      const releaseDate = item.release_date || item.first_air_date
      if (!isYearSafe(video.year, releaseDate)) continue

      const tmdbTitle = item.title || item.name
      if (tmdbTitle === cleanTitle) {
        bestMatch = item
        break
      }
      if (!bestMatch) bestMatch = item
    }

    if (!bestMatch) {
      await markAsDone(video._id)
      return
    }

    const detailRes = await tmdbApi.get(
      `/${bestMatch.media_type}/${bestMatch.id}`,
      {
        params: {
          append_to_response: "credits,keywords,networks,production_companies",
        },
      }
    )

    const updateData = buildUpdateData(video, bestMatch, detailRes.data)
    await applyUpdateWithMerge(video, updateData)
  } catch (error) {
    // 出错也标记完成，防止死循环
    await markAsDone(video._id)
  }
}

// ... (buildUpdateData 和 applyUpdateWithMerge 保持不变) ...
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
  let country = ""
  if (details.production_countries?.length > 0)
    country = details.production_countries[0].name

  let newTags = localVideo.tags ? [...localVideo.tags] : []
  if (details.genres) newTags.push(...details.genres.map((g) => g.name))
  const companies = [
    ...(details.networks || []),
    ...(details.production_companies || []),
  ]
  const cNames = companies.map((c) => c.name.toLowerCase())
  if (cNames.some((n) => n.includes("netflix"))) newTags.push("Netflix")
  if (cNames.some((n) => n.includes("hbo"))) newTags.push("HBO")

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
        (match.release_date || match.first_air_date || "").substring(0, 4)
      ) || localVideo.year,
    category: match.media_type === "movie" ? "movie" : "tv",
    director: directors,
    actors: cast,
    country: country,
    language: details.original_language,
    tags: [...new Set(newTags)],
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
            (es) => es.source_key === s.source_key && es.vod_id === s.vod_id
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

// ==========================================
// 5. 主程序 (极速批处理)
// ==========================================
async function syncTask(isFullScan = false) {
  console.log(`🚀 [TMDB极速清洗] 启动 (并发: ${CONCURRENCY})...`)

  const query = { is_enriched: false }
  let totalLeft = await Video.countDocuments(query)
  const totalStart = totalLeft
  console.log(`📊 待处理: ${totalStart} 条`)

  if (totalLeft === 0) return

  // 🔥 核心修改 3：增大 Batch Size，减少 DB 交互次数
  // 一次取 500 条
  const BATCH_SIZE = 500

  while (totalLeft > 0) {
    try {
      // 🔥 核心修改 4：使用 .lean() 加速查询
      // 注意：使用了 lean() 后，返回的是普通对象，不是 Mongoose 文档
      // save() 不能用了，必须用 updateOne (我们上面已经改好了)
      const batchDocs = await Video.find(query)
        .select("_id title year category tags sources tmdb_id overview poster")
        .limit(BATCH_SIZE)
        .lean()

      if (batchDocs.length === 0) break

      // 使用 p-limit 控制并发
      const promises = batchDocs.map((doc) => {
        return limit(() => enrichSingleVideo(doc))
      })

      await Promise.all(promises)

      // 更新进度
      const newTotalLeft = await Video.countDocuments(query)
      if (newTotalLeft === totalLeft) {
        // 防死循环兜底
        console.error("⛔ 进度卡死，强制终止")
        break
      }

      totalLeft = newTotalLeft
      const processed = totalStart - totalLeft

      // 显示进度
      console.log(`⚡ 进度: ${processed} / ${totalStart} (剩余: ${totalLeft})`)

      // 🔥 核心修改 5：移除所有人为的 setTimeout 延迟
      // 依靠 axios 拦截器处理限流，不人为降速
    } catch (err) {
      console.error(`💥 批次出错: ${err.message}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  console.log("✅ 清洗任务结束")
}

if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI
  const mongoose = require("mongoose")
  if (!MONGO_URI) {
    console.error("无 MONGO_URI")
    process.exit(1)
  }

  mongoose.connect(MONGO_URI).then(async () => {
    await syncTask(true)
    process.exit(0)
  })
}

module.exports = { syncTask }
