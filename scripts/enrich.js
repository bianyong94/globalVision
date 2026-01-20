require("dotenv").config()
const axios = require("axios")
const pLimit = require("p-limit")
const Video = require("../models/Video")

// ==========================================
// 1. 配置
// ==========================================
const TMDB_TOKEN = process.env.TMDB_TOKEN
// 增加超时设置到 8秒，防止请求挂起太久
const tmdbApi = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  params: { language: "zh-CN" },
  timeout: 8000,
})

// 降低并发到 3，求稳不求快，防止 TMDB 报错
const limit = pLimit(3)

function isYearSafe(localYear, tmdbDateStr) {
  if (!localYear || localYear === 0) return true
  if (!tmdbDateStr) return false
  const tmdbYear = parseInt(tmdbDateStr.substring(0, 4))
  return Math.abs(localYear - tmdbYear) <= 1
}

// ==========================================
// 2. 核心：兜底与忽略
// ==========================================

// 标记为已完成 (无论成功失败，都调用这个)
async function markAsDone(id, reason = "") {
  try {
    // 这里的逻辑是：只要跑过一次，就标记 is_enriched=true
    // 如果之前有 tmdb_id 就留着，没有就没有，绝不删除旧 ID
    if (reason) {
      // console.log(`⚠️ [跳过] ${reason}`);
    }
    await Video.updateOne({ _id: id }, { $set: { is_enriched: true } })
  } catch (e) {
    console.error(`❌ 状态更新失败: ${e.message}`)
  }
}

async function markAsIgnored(id) {
  try {
    // 只有确定是垃圾数据时，才删除 ID
    await Video.updateOne(
      { _id: id },
      { $set: { is_enriched: true }, $unset: { tmdb_id: "" } }
    )
  } catch (e) {}
}

// ==========================================
// 3. 单条清洗逻辑
// ==========================================
async function enrichSingleVideo(video) {
  const rawTitle = video.title || ""

  // 🔥🔥🔥 全局 Try-Catch：确保任何错误都不会导致死循环
  try {
    // A. 垃圾数据熔断
    if (/短剧|爽文|爽剧|反转|赘婿|战神|逆袭|重生|写真|福利/.test(rawTitle)) {
      await markAsIgnored(video._id)
      return
    }

    // B. 标题预处理
    const cleanTitle = rawTitle
      .replace(/第[0-9一二三四五六七八九十]+[季部]/g, "")
      .replace(/S[0-9]+/i, "")
      .replace(/1080P|4K|HD|BD|中字|双语|国语|未删减|完整版|蓝光/gi, "")
      .replace(/[\[\(（].*?[\]\)）]/g, "")
      .trim()

    if (!cleanTitle) {
      await markAsDone(video._id, "标题无效")
      return
    }

    // C. 搜索 TMDB
    const searchRes = await tmdbApi.get("/search/multi", {
      params: { query: cleanTitle },
    })

    const results = searchRes.data.results || []
    if (results.length === 0) {
      await markAsDone(video._id, "TMDB无结果")
      return
    }

    // D. 匹配最佳结果
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
      await markAsDone(video._id, "匹配校验失败")
      return
    }

    // E. 获取详情
    const detailRes = await tmdbApi.get(
      `/${bestMatch.media_type}/${bestMatch.id}`,
      {
        params: {
          append_to_response: "credits,keywords,networks,production_companies",
        },
      }
    )

    // F. 更新与合并
    const updateData = buildUpdateData(video, bestMatch, detailRes.data)
    await applyUpdateWithMerge(video, updateData)
  } catch (error) {
    // 🔥🔥🔥 关键修复：就算报错了，也标记为“已处理”，防止死循环！
    // console.error(`❌ 处理出错 [${rawTitle}]: ${error.message} -> 强制跳过`);
    await markAsDone(video._id)
  }
}

// ==========================================
// 4. 辅助函数
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
      // 其他保存错误，也尝试强制标记为已清洗，防止卡死
      await markAsDone(currentVideo._id)
    }
  }
}

// ==========================================
// 5. 主程序 (分批处理模式)
// ==========================================
async function runEnrichTask(isFullScan = false) {
  console.log(`🚀 [TMDB清洗] 任务启动...`)

  const query = { is_enriched: false }
  let totalLeft = await Video.countDocuments(query)
  const totalStart = totalLeft
  console.log(`📊 待处理: ${totalStart} 条`)

  if (totalLeft === 0) return

  // 只要还有没洗过的，就继续循环
  while (totalLeft > 0) {
    try {
      // 每次取 200 条
      const batchDocs = await Video.find(query)
        .select("_id title year category tags sources tmdb_id overview poster")
        .limit(200)

      if (batchDocs.length === 0) break

      // 并发处理
      const promises = batchDocs.map((doc) => {
        return limit(() => enrichSingleVideo(doc))
      })

      await Promise.all(promises)

      // 重新计算剩余数量
      const newTotalLeft = await Video.countDocuments(query)

      // 🔥 死循环检测：如果处理了一轮，数量完全没变，说明出大问题了，强制中断
      if (newTotalLeft === totalLeft) {
        console.error(
          "⛔ [警告] 队列未动，检测到死循环风险，强制停止本次任务。"
        )
        break
      }

      totalLeft = newTotalLeft
      const processed = totalStart - totalLeft
      console.log(`⏳ 进度: ${processed} / ${totalStart} (剩余: ${totalLeft})`)

      // 休息一下，防止被封
      await new Promise((r) => setTimeout(r, 1000))
    } catch (err) {
      console.error(`💥 批次出错: ${err.message}`)
      await new Promise((r) => setTimeout(r, 5000))
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
    await runEnrichTask(true)
    process.exit(0)
  })
}

module.exports = { runEnrichTask }
