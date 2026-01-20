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

// Zeabur 直连 TMDB
const tmdbApi = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
  params: { language: "zh-CN" },
  timeout: 10000,
})

// 并发数控制 (建议 5)
const limit = pLimit(5)

// ==========================================
// 2. 校验逻辑
// ==========================================
function isYearSafe(localYear, tmdbDateStr) {
  if (!localYear || localYear === 0) return true // 本地无年份，宽容放行
  if (!tmdbDateStr) return false
  const tmdbYear = parseInt(tmdbDateStr.substring(0, 4))
  return Math.abs(localYear - tmdbYear) <= 1 // 误差 ±1年
}

// ==========================================
// 3. 核心：兜底与忽略逻辑 (修复报错的关键)
// ==========================================

/**
 * 🔥 核心兜底函数
 * 逻辑：匹配失败时，如果有旧ID就保留（防止变黑户），没有就标记忽略（防止死循环）
 */
async function keepOldOrIgnore(video, reason = "") {
  try {
    // 检查 video.tmdb_id 是否存在且是一个有效的正数
    // 注意：之前可能存过 -1，我们要把它视为无效
    if (video.tmdb_id && video.tmdb_id !== -1) {
      // console.log(`🛡️ [兜底] ${reason} -> 保留旧ID: ${video.tmdb_id}`);
      // 只更新状态，不改动 tmdb_id
      await Video.updateOne({ _id: video._id }, { $set: { is_enriched: true } })
    } else {
      // console.log(`🗑️ [忽略] ${reason} -> 标记为已处理`);
      await markAsIgnored(video._id)
    }
  } catch (e) {
    console.error(`❌ 兜底处理失败: ${e.message}`)
  }
}

/**
 * 标记为忽略
 * 🔥 修复重点：不再写入 tmdb_id: -1，而是直接 $unset 删除该字段
 * 配合 Sparse 索引，可以彻底解决 E11000 duplicate key error
 */
async function markAsIgnored(id) {
  try {
    await Video.updateOne(
      { _id: id },
      {
        $set: { is_enriched: true }, // 标记为洗过了
        $unset: { tmdb_id: "" }, // 删掉 ID 字段，避免冲突
      }
    )
  } catch (e) {
    if (e.code !== 11000) console.error(`标记忽略失败: ${e.message}`)
  }
}

// ==========================================
// 4. 单条清洗逻辑
// ==========================================
async function enrichSingleVideo(video) {
  const rawTitle = video.title || ""

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
    await keepOldOrIgnore(video, "标题为空")
    return
  }

  try {
    // C. 搜索 TMDB
    const searchRes = await tmdbApi.get("/search/multi", {
      params: { query: cleanTitle },
    })

    const results = searchRes.data.results || []

    // 没搜到 -> 兜底
    if (results.length === 0) {
      await keepOldOrIgnore(video, `TMDB无结果: ${cleanTitle}`)
      return
    }

    // D. 匹配最佳结果
    let bestMatch = null
    for (const item of results) {
      // 类型校验
      let isLocalMovie = video.category === "movie"
      let isLocalTv = ["tv", "anime", "variety"].includes(video.category)

      if (isLocalMovie && item.media_type !== "movie") continue
      if (isLocalTv && item.media_type !== "tv") continue

      // 年份校验
      const releaseDate = item.release_date || item.first_air_date
      if (!isYearSafe(video.year, releaseDate)) continue

      // 标题完全一致直接选中
      const tmdbTitle = item.title || item.name
      if (tmdbTitle === cleanTitle) {
        bestMatch = item
        break
      }
      // 否则作为备选
      if (!bestMatch) bestMatch = item
    }

    // 匹配失败 -> 兜底
    if (!bestMatch) {
      await keepOldOrIgnore(video, `校验未通过: ${cleanTitle}`)
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
    console.error(`❌ 出错 [${rawTitle}]: ${error.message}`)
  }
}

// ==========================================
// 5. 数据组装与合并
// ==========================================

function buildUpdateData(localVideo, match, details) {
  // 提取演职员
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

  // 提取国家
  let country = ""
  if (details.production_countries?.length > 0)
    country = details.production_countries[0].name

  // 智能标签
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
    // 尝试更新
    await Video.updateOne({ _id: currentVideo._id }, { $set: updateData })
  } catch (error) {
    // 处理唯一索引冲突 (E11000) -> 合并逻辑
    if (error.code === 11000) {
      const existingVideo = await Video.findOne({ tmdb_id: updateData.tmdb_id })

      // 确保不是自己撞自己
      if (
        existingVideo &&
        existingVideo._id.toString() !== currentVideo._id.toString()
      ) {
        // console.log(`🔀 [合并] ${updateData.title} (ID: ${updateData.tmdb_id})`);

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

        // 删除当前冗余数据
        await Video.deleteOne({ _id: currentVideo._id })
      }
    }
  }
}

async function runEnrichTask(isFullScan = false) {
  console.log(`🚀 [TMDB清洗] 任务启动...`)

  const query = { is_enriched: false }

  // 1. 先获取总数，用于显示进度
  let totalLeft = await Video.countDocuments(query)
  const totalStart = totalLeft
  console.log(`📊 初始待处理: ${totalStart} 条`)

  if (totalLeft === 0) {
    console.log("✨ 暂无需要清洗的数据")
    return
  }

  // 2. 循环分批处理
  // 只要还有没洗过的数据，就继续循环
  while (totalLeft > 0) {
    try {
      // 每次只取 200 条
      // lean() 可以让查询更快，返回普通 JS 对象 (但我们需要 save，所以这里不用 lean，或者手动 hydrate)
      // 这里直接取文档以便使用 .save()
      const batchDocs = await Video.find(query)
        .select("_id title year category tags sources tmdb_id overview poster") // 只取需要的字段，减少内存
        .limit(200)

      if (batchDocs.length === 0) break // 双重保险

      // 并发处理这 200 条
      const promises = batchDocs.map((doc) => {
        // 使用 p-limit 限制并发数为 5
        return limit(() => enrichSingleVideo(doc))
      })

      // 等待这一批全部做完
      await Promise.all(promises)

      // 更新剩余数量
      // 注意：不能简单的 totalLeft - 200，因为可能有处理失败的
      // 我们重新查一次剩余数量，虽然有一点点性能损耗，但进度最准确
      totalLeft = await Video.countDocuments(query)

      const processed = totalStart - totalLeft
      console.log(`⏳ 进度: ${processed} / ${totalStart} (剩余: ${totalLeft})`)

      // 休息一下，防止 TMDB 也就是太频繁封 IP
      await new Promise((r) => setTimeout(r, 1000))
    } catch (err) {
      console.error(`💥 批次处理出错: ${err.message}`)
      // 出错后休息久一点再试
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  console.log("✅ 所有清洗任务完成")
}

// 本地调试入口
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
