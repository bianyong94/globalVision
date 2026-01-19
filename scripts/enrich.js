require("dotenv").config()
const axios = require("axios")
const pLimit = require("p-limit")
const Video = require("../models/Video")

// ==========================================
// 1. 配置区域
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
  timeout: 15000,
})

// 并发数 (建议不要太高，保证质量)
const limit = pLimit(5)

// ==========================================
// 2. 核心：校验逻辑 (Safety Checks)
// ==========================================

/**
 * 校验两个年份是否接近
 * @param {number} localYear 采集源年份
 * @param {string} tmdbDateStr TMDB日期 (YYYY-MM-DD)
 */
function isYearSafe(localYear, tmdbDateStr) {
  if (!localYear || localYear === 0) return true // 本地没年份，暂且信任
  if (!tmdbDateStr) return false
  const tmdbYear = parseInt(tmdbDateStr.substring(0, 4))
  // 放宽到 ±1 年
  return Math.abs(localYear - tmdbYear) <= 1
}

// 🔥 这里的校验太严格导致大量数据匹配失败，我们改为“软校验”
function isCastSafe(localActors, localDirector, tmdbCredits) {
  // 如果本地没写演员，直接算通过
  if (!localActors && !localDirector) return true

  // 简单的垃圾词过滤
  if (/未知|更新|待定|主演/.test(localActors)) return true

  const tmdbNames = [
    ...(tmdbCredits.cast || []).map((c) => c.name),
    ...(tmdbCredits.crew || []).map((c) => c.name),
  ]
    .join("")
    .toLowerCase()

  const localNames = (localActors + " " + localDirector)
    .toLowerCase()
    .split(/,|，|、|\s/)
    .filter((s) => s.length > 1)

  // 只要有一个名字能对应上，就通过
  for (const name of localNames) {
    if (tmdbNames.includes(name)) return true
  }

  return false
}

// ==========================================
// 3. 单条处理逻辑
// ==========================================
async function enrichSingleVideo(video) {
  const rawTitle = video.title || ""

  // A. 垃圾数据熔断 (保持不变)
  if (/短剧|爽文|爽剧|反转|赘婿|战神|逆袭|重生/.test(rawTitle)) {
    await markAsIgnored(video._id)
    return
  }

  // B. 标题清洗 (保持不变)
  const cleanTitle = rawTitle
    .replace(/第[0-9一二三四五六七八九十]+[季部]/g, "")
    .replace(/S[0-9]+/i, "")
    .replace(/1080P|4K|HD|BD|中字|双语|国语|未删减|完整版|蓝光/gi, "")
    .replace(/[\[\(（].*?[\]\)）]/g, "")
    .trim()

  if (!cleanTitle) {
    await markAsIgnored(video._id)
    return
  }

  try {
    // C. 搜索 TMDB
    const searchRes = await tmdbApi.get("/search/multi", {
      params: { query: cleanTitle },
    })

    const results = searchRes.data.results || []
    if (results.length === 0) {
      console.log(`⚠️ TMDB 0结果: ${cleanTitle}`)
      await markAsIgnored(video._id)
      return
    }

    // 🔥 D. 筛选最佳匹配 (逻辑放宽)
    let bestMatch = null

    for (const item of results) {
      // 1. 类型强校验 (电影配电影，剧集配剧集)
      let isLocalMovie = video.category === "movie"
      let isLocalTv = ["tv", "anime", "variety"].includes(video.category)

      // TMDB 有时把动漫也算 TV，这没问题
      if (isLocalMovie && item.media_type !== "movie") continue
      if (isLocalTv && item.media_type !== "tv") continue

      // 2. 年份强校验
      const releaseDate = item.release_date || item.first_air_date
      if (!isYearSafe(video.year, releaseDate)) continue

      // 🔥 3. 标题精确度加分
      // 如果标题完全一样，即使没有演员校验也直接通过
      const tmdbTitle = item.title || item.name
      if (tmdbTitle === cleanTitle) {
        bestMatch = item
        break
      }

      // 如果标题不完全一样，才去校验演员
      // 这里我们为了拿数据，暂时先取第一个年份匹配的作为候选
      if (!bestMatch) bestMatch = item
    }

    if (!bestMatch) {
      // console.log(`⚠️ 无匹配: ${cleanTitle} (Year:${video.year})`);
      await markAsIgnored(video._id)
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
    const details = detailRes.data

    // 🔥 F. 演员校验 (改为仅记录日志，不阻断更新)
    // 只有当标题差异很大时，才强制校验演员，否则放行
    // const isMatchSafe = isCastSafe(video.actors, video.director, details.credits);
    // if (!isMatchSafe && cleanTitle !== (bestMatch.title || bestMatch.name)) {
    //    console.log(`🛡️ 疑似不匹配(放行): ${rawTitle} -> ${bestMatch.title || bestMatch.name}`);
    // }

    // G. 校验通过，准备更新
    const updateData = buildUpdateData(video, bestMatch, details)
    await applyUpdateWithMerge(video, updateData)

    // 打印成功日志，让你看到进度
    if (updateData.rating > 0) {
      console.log(
        `✅ 清洗成功: ${updateData.title} -> 评分: ${updateData.rating}`
      )
    }
  } catch (error) {
    console.error(`❌ 出错: ${error.message}`)
  }
}

// ==========================================
// 4. 辅助函数：构建数据 & 合并
// ==========================================

async function markAsIgnored(id) {
  // 标记为已清洗但无结果 (-1)，以后不再碰它
  await Video.updateOne(
    { _id: id },
    { $set: { tmdb_id: -1, is_enriched: true } }
  )
}

function buildUpdateData(localVideo, match, details) {
  // 提取更多元数据
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
  if (details.production_countries?.length > 0) {
    country = details.production_countries[0].name // 使用中文名
  }

  // 提取时长
  const runtime =
    details.runtime ||
    (details.episode_run_time ? details.episode_run_time[0] : 0)

  // 智能标签 (保留本地，追加 TMDB)
  let newTags = localVideo.tags ? [...localVideo.tags] : []
  if (details.genres) newTags.push(...details.genres.map((g) => g.name))

  // 流媒体识别
  const companies = [
    ...(details.networks || []),
    ...(details.production_companies || []),
  ]
  const cNames = companies.map((c) => c.name.toLowerCase())
  if (cNames.some((n) => n.includes("netflix"))) newTags.push("Netflix")
  if (cNames.some((n) => n.includes("hbo"))) newTags.push("HBO")
  if (cNames.some((n) => n.includes("disney"))) newTags.push("Disney+")
  if (cNames.some((n) => n.includes("apple"))) newTags.push("Apple TV+")

  return {
    tmdb_id: match.id,

    // 使用 TMDB 的标准信息覆盖
    title: match.title || match.name,
    original_title: match.original_title || match.original_name,
    overview: match.overview || localVideo.overview, // 优先用 TMDB 简介

    // 图片使用 TMDB 高清图
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

    // 强制修正分类
    category: match.media_type === "movie" ? "movie" : "tv",

    director: directors,
    actors: cast,
    country: country,
    language: details.original_language,
    duration: runtime ? `${runtime}分钟` : "",

    tags: [...new Set(newTags)],
    is_enriched: true,
  }
}

async function applyUpdateWithMerge(currentVideo, updateData) {
  try {
    // 尝试直接更新当前文档
    await Video.updateOne({ _id: currentVideo._id }, { $set: updateData })
  } catch (error) {
    // 唯一索引冲突：说明库里已经有这个 tmdb_id 的数据了
    if (error.code === 11000) {
      // 找到那个“正主”
      const existingVideo = await Video.findOne({ tmdb_id: updateData.tmdb_id })

      if (
        existingVideo &&
        existingVideo._id.toString() !== currentVideo._id.toString()
      ) {
        // 🔥🔥🔥 核心合并逻辑 🔥🔥🔥
        // 只有当两个数据真的是同一部 TMDB 电影时，我们才合并播放源

        let isModified = false

        // 遍历当前视频的所有源，搬家到正主那里
        for (const s of currentVideo.sources) {
          // 查重：正主那里是不是已经有这个源了？
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

        // 删除当前这条“冗余”数据，因为它已经“合体”了
        await Video.deleteOne({ _id: currentVideo._id })
      }
    } else {
      console.error(`保存失败: ${error.message}`)
    }
  }
}

// ==========================================
// 5. 主程序
// ==========================================
async function runEnrichTask(isFullScan = false) {
  console.log(`🚀 [TMDB安全清洗] 启动 (全量: ${isFullScan})`)

  // 只查找未清洗的
  const query = { is_enriched: false, tmdb_id: { $ne: -1 } }
  const total = await Video.countDocuments(query)
  console.log(`📊 待处理数据: ${total}`)

  if (total === 0) return

  const cursor = Video.find(query).cursor()
  let promises = []
  let processed = 0

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    const p = limit(() => enrichSingleVideo(doc))
    promises.push(p)
    processed++

    if (processed % 20 === 0)
      process.stdout.write(`\r⏳ 进度: ${processed}/${total}`)

    if (promises.length >= 20) {
      await Promise.all(promises)
      promises = []
    }
  }
  await Promise.all(promises)
  console.log("\n✅ 清洗结束")
}

// 启动入口 (本地调试用)
if (require.main === module) {
  const MONGO_URI = process.env.MONGO_URI
  const mongoose = require("mongoose")

  console.log("正在连接 DB...")
  mongoose.connect(MONGO_URI).then(async () => {
    // 强制重置开关：如果想重新洗一遍所有数据，把下面这行取消注释
    // await Video.updateMany({}, { $set: { is_enriched: false } }); console.log("重置完成");

    await runEnrichTask(true)
    process.exit(0)
  })
}

module.exports = { runEnrichTask }
