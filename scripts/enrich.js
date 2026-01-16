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
  // 如果本地没年份，视为不安全，返回 false (宁可不洗，也不瞎洗)
  // 除非你想允许模糊匹配，可以改成 return true
  if (!localYear || localYear === 0) return false
  if (!tmdbDateStr) return false

  const tmdbYear = parseInt(tmdbDateStr.substring(0, 4))
  // 允许 1 年误差 (上映时间跨年问题)
  return Math.abs(localYear - tmdbYear) <= 1
}

/**
 * 校验演员/导演重合度 (指纹识别)
 * @param {string} localActors 本地演员字符串
 * @param {string} localDirector 本地导演字符串
 * @param {Object} tmdbCredits TMDB 演职员对象
 */
function isCastSafe(localActors, localDirector, tmdbCredits) {
  // 1. 如果本地完全没演员也没导演，无法校验，视为“中立安全”
  // (但为了极度严谨，这里也可以返回 false，要求必须有元数据才能清洗)
  if (!localActors && !localDirector) return true

  const cleanLocal = (str) => (str || "").replace(/[ ,，、]/g, "") // 去除标点

  // 提取 TMDB 的人名
  const tmdbCastNames = (tmdbCredits.cast || []).slice(0, 10).map((c) => c.name)
  const tmdbCrewNames = (tmdbCredits.crew || [])
    .filter((c) => c.job === "Director")
    .map((c) => c.name)

  const allTmdbNames = [...tmdbCastNames, ...tmdbCrewNames].join("")

  // 检查匹配度
  // 逻辑：本地提供的演员/导演，至少有一个要在 TMDB 里出现过
  const actorsArr = (localActors || "")
    .split(/,|，|、|\s/)
    .filter((s) => s.length > 1)
  const directorsArr = (localDirector || "")
    .split(/,|，|、|\s/)
    .filter((s) => s.length > 1)

  const allLocalNames = [...actorsArr, ...directorsArr]

  if (allLocalNames.length === 0) return true

  // 只要有一个名字对上了，就认为是同一部片
  for (const name of allLocalNames) {
    if (allTmdbNames.includes(name)) return true
  }

  // 到了这里说明：本地写了一堆演员，结果 TMDB 里一个都没对上
  // 极大概率是同名不同片 (如《红楼梦》87版 vs 10版)
  // console.log(`🔒 指纹校验失败: 本地[${allLocalNames}] vs TMDB[${tmdbCastNames.slice(0,3)}]`);
  return false
}

// ==========================================
// 3. 单条处理逻辑
// ==========================================
async function enrichSingleVideo(video) {
  const rawTitle = video.title || ""

  // A. 垃圾数据熔断
  if (/短剧|爽文|爽剧|反转|赘婿|战神|逆袭|重生|写真|福利|伦理/.test(rawTitle)) {
    await markAsIgnored(video._id)
    return
  }

  // B. 标题预处理
  // 移除第几季，只搜纯名字，提高 TMDB 命中率
  const searchTitle = rawTitle
    .replace(/第[0-9一二三四五六七八九十]+[季部]/g, "")
    .replace(/S[0-9]+/i, "")
    .replace(/1080P|4K|HD|BD|中字|国语|完整版/gi, "")
    .replace(/[\[\(（].*?[\]\)）]/g, "")
    .trim()

  if (!searchTitle) {
    await markAsIgnored(video._id)
    return
  }

  try {
    // C. 搜索 TMDB
    const searchRes = await tmdbApi.get("/search/multi", {
      params: { query: searchTitle },
    })

    const results = searchRes.data.results || []
    if (results.length === 0) {
      await markAsIgnored(video._id)
      return
    }

    // 🔥 D. 筛选最佳匹配 (Safety First)
    let bestMatch = null

    for (const item of results) {
      // 1. 类型校验
      let isLocalMovie = video.category === "movie"
      let isLocalTv = ["tv", "anime", "variety"].includes(video.category)
      if (isLocalMovie && item.media_type !== "movie") continue
      if (isLocalTv && item.media_type !== "tv") continue

      // 2. 年份校验 (必须过)
      const releaseDate = item.release_date || item.first_air_date
      if (!isYearSafe(video.year, releaseDate)) continue

      // 如果通过了基础校验，暂定为候选
      bestMatch = item
      break // 取第一个年份和类型都对得上的
    }

    if (!bestMatch) {
      // console.log(`⚠️ 无安全匹配: ${rawTitle} (Year:${video.year})`);
      await markAsIgnored(video._id)
      return
    }

    // E. 获取详情 + 演职员表 (用于指纹校验)
    const detailRes = await tmdbApi.get(
      `/${bestMatch.media_type}/${bestMatch.id}`,
      {
        params: {
          append_to_response: "credits,keywords,networks,production_companies",
        },
      }
    )
    const details = detailRes.data

    // 🔥 F. 演职员指纹终极校验
    if (!isCastSafe(video.actors, video.director, details.credits)) {
      console.log(
        `🛡️ 拦截潜在错误匹配: ${rawTitle} -> TMDB: ${
          bestMatch.title || bestMatch.name
        }`
      )
      await markAsIgnored(video._id)
      return
    }

    // G. 校验通过，准备更新
    const updateData = buildUpdateData(video, bestMatch, details)

    // H. 执行合并更新
    await applyUpdateWithMerge(video, updateData)
  } catch (error) {
    console.error(`❌ 处理出错 [${rawTitle}]: ${error.message}`)
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
