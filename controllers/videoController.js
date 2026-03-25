const Video = require("../models/Video")
const { getCache, setCache } = require("../utils/cache")
const { getAxiosConfig } = require("../utils/httpAgent")
// 👇 1. 引入优先级配置
const { sources, PRIORITY_LIST } = require("../config/sources")
const axios = require("axios")
const mongoose = require("mongoose")
const {
  shouldBlockShortDrama,
  scoreShortDrama,
} = require("../utils/shortDramaFilter")
const { evaluateAdultContent } = require("../utils/adultContentFilter")

const SOURCE_PROBE_TIMEOUT_MS = 2500
const SOURCE_PROBE_CACHE_TTL_SEC = 1800
const SOURCE_PROBE_STALE_MS = 10 * 60 * 1000
const SOURCE_PROBE_INFLIGHT = new Map()
const CHINESE_NUM_MAP = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

const escapeRegex = (string) => {
  return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
}

const toSafeRating = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return parseFloat(n.toFixed(1))
}

const buildHomeSeed = () => {
  const now = new Date()
  const hourBucket = Math.floor(now.getHours() / 6) // 每6小时换一轮
  return (
    now.getFullYear() * 10000 +
    (now.getMonth() + 1) * 200 +
    now.getDate() * 10 +
    hourBucket
  )
}

const rotateList = (arr = [], seed = 0) => {
  if (!Array.isArray(arr) || arr.length === 0) return []
  const offset = Math.abs(seed) % arr.length
  if (offset === 0) return arr
  return [...arr.slice(offset), ...arr.slice(0, offset)]
}

const uniqById = (arr = []) => {
  const used = new Set()
  return arr.filter((item) => {
    const id = String(item?._id || item?.id || "")
    if (!id || used.has(id)) return false
    used.add(id)
    return true
  })
}

const HOME_NOISE_REGEX =
  /豪门后妈|人生赢家|神豪|赘婿|逆袭|娇妻|千金|龙王|战神|闪婚|前妻|下山|师姐|仙尊|大凶之兆|最强收徒/i

const isHighQualityHomeItem = (doc = {}) => {
  const text = `${doc.title || ""} ${doc.remarks || ""} ${doc.latest_remarks || ""}`
  if (HOME_NOISE_REGEX.test(text)) return false

  const judged = scoreShortDrama(
    {
      vod_name: doc.title || "",
      vod_remarks: `${doc.remarks || ""} ${doc.latest_remarks || ""} ${(doc.tags || []).join(" ")}`,
      vod_area: doc.area || "",
      vod_year: doc.year || "",
      vod_play_url: Array.isArray(doc.sources)
        ? doc.sources[0]?.vod_play_url || ""
        : "",
    },
    "",
  )

  if (judged.blocked) return false
  return true
}

const pickUniqueFromPool = (pool, usedSet, limit, seed, options = {}) => {
  const picked = []
  const ordered = options.keepOrder ? pool : rotateList(pool, seed)
  for (const item of ordered) {
    const id = String(item?._id || item?.id || "")
    if (!id || usedSet.has(id)) continue
    usedSet.add(id)
    picked.push(item)
    if (picked.length >= limit) break
  }
  return picked
}

const parseChineseNumber = (text = "") => {
  const str = String(text).trim()
  if (!str) return null
  if (/^\d+$/.test(str)) return parseInt(str, 10)
  if (str === "十") return 10
  if (str.startsWith("十")) {
    const tail = CHINESE_NUM_MAP[str[1]] || 0
    return 10 + tail
  }
  if (str.includes("十")) {
    const [head, tail] = str.split("十")
    const tens = CHINESE_NUM_MAP[head] || 0
    const units = CHINESE_NUM_MAP[tail] || 0
    return tens * 10 + units
  }
  return CHINESE_NUM_MAP[str] ?? null
}

const toChineseNumber = (num) => {
  const n = Number(num)
  if (!Number.isFinite(n) || n <= 0) return ""
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
  if (n < 10) return digits[n]
  if (n === 10) return "十"
  if (n < 20) return `十${digits[n - 10]}`
  if (n < 100) {
    const tens = Math.floor(n / 10)
    const units = n % 10
    return `${digits[tens]}十${units ? digits[units] : ""}`
  }
  return String(n)
}

const stripSeasonSuffix = (title = "") =>
  String(title)
    .replace(
      /(?:第\s*[一二两三四五六七八九十百\d]+\s*[季部]|Season\s*\d+|S\d{1,2})/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim()

const normalizeSearchText = (text = "") =>
  String(text)
    .toLowerCase()
    .replace(/[《》“”"'·\-_:：，,\.\!！\?？\(\)\[\]\{\}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const extractSeasonNoFromText = (text = "") => {
  const str = String(text || "")
  let m = str.match(/第\s*([一二两三四五六七八九十百\d]+)\s*[季部]/i)
  if (m) {
    const n = parseChineseNumber(m[1])
    if (n && n > 0) return n
  }
  m = str.match(/\bSeason\s*([0-9]{1,2})\b/i)
  if (m) return parseInt(m[1], 10)
  m = str.match(/\bS0*([0-9]{1,2})\b/i)
  if (m) return parseInt(m[1], 10)
  return null
}

const rankSearchResults = (rows = [], keyword = "") => {
  const wdNorm = normalizeSearchText(keyword)
  const wdBase = normalizeSearchText(stripSeasonSuffix(keyword))

  const ranked = rows.map((item) => {
    const titleNorm = normalizeSearchText(item.title || "")
    const titleBase = normalizeSearchText(stripSeasonSuffix(item.title || ""))
    const originalNorm = normalizeSearchText(item.original_title || "")
    const actorsNorm = normalizeSearchText(item.actors || "")
    const directorNorm = normalizeSearchText(item.director || "")
    const seasonNo = extractSeasonNoFromText(item.title || "")

    const exactTitle = wdNorm && titleNorm === wdNorm
    const exactOriginal = wdNorm && originalNorm === wdNorm
    const sameSeries = wdBase && titleBase && wdBase === titleBase

    const titlePrefix = wdNorm && (titleNorm.startsWith(wdNorm) || originalNorm.startsWith(wdNorm))
    const titleContains = wdNorm && (titleNorm.includes(wdNorm) || originalNorm.includes(wdNorm))
    const actorHit = wdNorm && actorsNorm.includes(wdNorm)
    const directorHit = wdNorm && directorNorm.includes(wdNorm)

    let score = 0
    if (exactTitle) score += 12000
    if (exactOriginal) score += 10000
    if (sameSeries) score += 9000
    if (titlePrefix) score += 7000
    if (titleContains) score += 4500
    if (actorHit) score += 1800
    if (directorHit) score += 1500

    // 轻微加权，避免同分时随机
    score += Math.min(Number(item.rating || 0) * 10, 120)

    return {
      ...item,
      _search_rank: {
        score,
        seasonNo: seasonNo ?? Number.MAX_SAFE_INTEGER,
        titleHit: Boolean(exactTitle || exactOriginal || sameSeries || titlePrefix || titleContains),
        actorDirectorHit: Boolean(actorHit || directorHit),
      },
    }
  })

  const hasTitleHit = ranked.some((x) => x._search_rank?.titleHit)

  ranked.sort((a, b) => {
    const ra = a._search_rank
    const rb = b._search_rank

    if (hasTitleHit) {
      if (ra.titleHit !== rb.titleHit) return ra.titleHit ? -1 : 1
      if (ra.score !== rb.score) return rb.score - ra.score
      // 同一系列时按季数升序
      if (ra.seasonNo !== rb.seasonNo) return ra.seasonNo - rb.seasonNo
    } else {
      if (ra.actorDirectorHit !== rb.actorDirectorHit)
        return ra.actorDirectorHit ? -1 : 1
      if (ra.score !== rb.score) return rb.score - ra.score
    }

    const rateA = Number(a.rating || 0)
    const rateB = Number(b.rating || 0)
    if (rateA !== rateB) return rateB - rateA

    return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  })

  return ranked
}

const parseSeasonInfo = (text = "") => {
  if (!text) return null
  const value = String(text)
  let match = value.match(/第\s*([一二两三四五六七八九十百\d]+)\s*[季部]/i)
  if (match) {
    const n = parseChineseNumber(match[1])
    if (n && n > 0)
      return { season_no: n, season_label: `第${toChineseNumber(n)}季` }
  }

  match = value.match(/\bSeason\s*([0-9]{1,2})\b/i)
  if (match) {
    const n = parseInt(match[1], 10)
    if (n > 0)
      return { season_no: n, season_label: `第${toChineseNumber(n)}季` }
  }

  match = value.match(/\bS0*([0-9]{1,2})\b/i)
  if (match) {
    const n = parseInt(match[1], 10)
    if (n > 0)
      return { season_no: n, season_label: `第${toChineseNumber(n)}季` }
  }

  return null
}

const buildSeasonCards = (videoDoc) => {
  const sources = Array.isArray(videoDoc.sources) ? videoDoc.sources : []
  if (sources.length === 0) return []

  const baseTitle = stripSeasonSuffix(videoDoc.title || "")
  const groups = new Map()

  for (const source of sources) {
    const sourceName = source.vod_name || videoDoc.title || ""
    const seasonInfo =
      parseSeasonInfo(sourceName) ||
      parseSeasonInfo(source.remarks || "") ||
      parseSeasonInfo(videoDoc.title || "")

    const key = seasonInfo ? `s_${seasonInfo.season_no}` : `raw_${sourceName}`
    if (!groups.has(key)) {
      groups.set(key, {
        season_no: seasonInfo?.season_no || null,
        season_label: seasonInfo?.season_label || "",
        items: [],
      })
    }
    groups.get(key).items.push(source)
  }

  const cards = []
  for (const [, group] of groups) {
    const sorted = [...group.items].sort(
      (a, b) => getPriorityIndex(a.source_key) - getPriorityIndex(b.source_key),
    )
    const primary = sorted[0]
    const epCount = String(primary?.vod_play_url || "")
      .split("#")
      .filter(Boolean).length
    const title =
      group.season_no && baseTitle
        ? `${baseTitle} ${group.season_label}`
        : primary?.vod_name || videoDoc.title

    cards.push({
      id: String(videoDoc._id),
      title,
      poster: videoDoc.poster,
      rating: toSafeRating(videoDoc.rating),
      year: videoDoc.year,
      category: videoDoc.category,
      remarks:
        epCount > 0
          ? `${group.season_label || ""} ${epCount}集`.trim()
          : primary?.remarks || "",
      source_ref:
        primary?.source_key && primary?.vod_id
          ? `${primary.source_key}::${primary.vod_id}`
          : "",
      season_no: group.season_no,
      season_label: group.season_label,
    })
  }

  cards.sort((a, b) => {
    const ta = stripSeasonSuffix(a.title)
    const tb = stripSeasonSuffix(b.title)
    if (ta !== tb) return ta.localeCompare(tb)
    const sa = a.season_no ?? Number.MAX_SAFE_INTEGER
    const sb = b.season_no ?? Number.MAX_SAFE_INTEGER
    return sa - sb
  })

  return cards
}

const getPriorityIndex = (sourceKey) => {
  const index = PRIORITY_LIST.indexOf(sourceKey)
  return index === -1 ? 999 : index
}

const extractPrimaryPlayUrl = (vodPlayUrl = "") => {
  if (!vodPlayUrl) return ""
  const firstEpisode = String(vodPlayUrl).split("#")[0] || ""
  const parts = firstEpisode.split("$")
  return (parts.length > 1 ? parts[1] : parts[0] || "").trim()
}

const getProbeCacheKey = (url) => {
  try {
    const u = new URL(String(url || ""))
    if (!u.hostname) return null
    return `source_probe_v1_${u.hostname.toLowerCase()}`
  } catch (e) {
    return null
  }
}

const scheduleProbeRefresh = (key, url) => {
  if (!key || !url) return
  if (SOURCE_PROBE_INFLIGHT.has(key)) return
  SOURCE_PROBE_INFLIGHT.set(key, true)
  setImmediate(async () => {
    try {
      const probe = await probeSource(url)
      await setCache(
        key,
        { ...probe, updated_at: Date.now() },
        SOURCE_PROBE_CACHE_TTL_SEC,
      )
    } catch (e) {
    } finally {
      SOURCE_PROBE_INFLIGHT.delete(key)
    }
  })
}

const probeSource = async (url) => {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { health: "unknown", latency_ms: null }
  }

  const start = Date.now()
  try {
    await axios.get(url, {
      maxRedirects: 3,
      responseType: "stream",
      validateStatus: (status) => status >= 200 && status < 500,
      ...getAxiosConfig({ timeout: SOURCE_PROBE_TIMEOUT_MS }),
    })
    return { health: "good", latency_ms: Date.now() - start }
  } catch (error) {
    return { health: "bad", latency_ms: null }
  }
}

const enrichAndSortSources = async (rawSources = []) => {
  if (!Array.isArray(rawSources) || rawSources.length === 0) return []

  const cachePromiseByKey = new Map()
  const tested = await Promise.all(
    rawSources.map(async (source) => {
      const plainSource =
        source && typeof source.toObject === "function"
          ? source.toObject()
          : source && source._doc
            ? source._doc
            : { ...source }
      const sampleUrl = extractPrimaryPlayUrl(source.vod_play_url)
      const key = getProbeCacheKey(sampleUrl)
      let probe = null
      if (key) {
        if (!cachePromiseByKey.has(key)) {
          cachePromiseByKey.set(key, getCache(key))
        }
        const cached = await cachePromiseByKey.get(key)
        if (cached && typeof cached === "object") {
          probe = {
            health: cached.health || "unknown",
            latency_ms:
              typeof cached.latency_ms === "number" ? cached.latency_ms : null,
          }
          const updatedAt = Number(cached.updated_at || 0)
          if (!updatedAt || Date.now() - updatedAt > SOURCE_PROBE_STALE_MS) {
            scheduleProbeRefresh(key, sampleUrl)
          }
        } else {
          scheduleProbeRefresh(key, sampleUrl)
        }
      }

      if (!probe) probe = { health: "unknown", latency_ms: null }
      return {
        ...plainSource,
        health: probe.health,
        latency_ms: probe.latency_ms,
      }
    }),
  )

  tested.sort((a, b) => {
    const healthRank = { good: 0, unknown: 1, bad: 2 }
    const healthA = healthRank[a.health] ?? 1
    const healthB = healthRank[b.health] ?? 1
    if (healthA !== healthB) return healthA - healthB

    const latencyA =
      typeof a.latency_ms === "number" ? a.latency_ms : Number.MAX_SAFE_INTEGER
    const latencyB =
      typeof b.latency_ms === "number" ? b.latency_ms : Number.MAX_SAFE_INTEGER
    if (latencyA !== latencyB) return latencyA - latencyB

    return getPriorityIndex(a.source_key) - getPriorityIndex(b.source_key)
  })

  return tested
}

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

// 辅助函数：统一返回格式
const formatDetail = (video) => {
  // 👇 2. 新增排序逻辑
  let finalSources = Array.isArray(video.sources) ? [...video.sources] : []
  if (finalSources.length > 1) {
    finalSources.sort((a, b) => {
      return getPriorityIndex(a.source_key) - getPriorityIndex(b.source_key)
    })
  }

  // 如果 sources 为空（旧数据），构造默认源
  if (finalSources.length === 0 && video.vod_play_url) {
    finalSources = [
      {
        source_key: video.source || "unknown",
        source_name: sources[video.source]?.name || "默认源",
        vod_play_url: video.vod_play_url,
        remarks: video.remarks,
      },
    ]
  }
  // 如果是聚合模型，sources 是数组
  // 我们需要确保返回给前端的结构是完整的
  return {
    id: video._id, // 核心 ID
    title: video.title,
    poster: video.poster,
    category: video.category,
    year: video.year,
    area: video.area,
    rating: video.rating,
    content: video.overview || video.content,
    actors: video.actors,
    director: video.director,
    tags: video.tags || [],

    sources: finalSources,
  }
}

exports.getVideos = async (req, res) => {
  try {
    const { cat, tag, area, year, sort, pg = 1, wd, view } = req.query
    const limit = 20
    const queryLimit = wd ? 120 : limit
    const skip = (parseInt(pg) - 1) * limit
    const shouldSeasonView = view === "season" && !!wd

    // ==========================================
    // 1. 构建筛选条件 ($match)
    // ==========================================
    const matchStage = {}
    const andConditions = [
      { title: { $not: /短剧|微短剧|爽剧|爽文|赘婿|miniseries/i } },
      {
        title: {
          $not: /(^|\b)(av|AV在线|成人视频|无码|有码|番号|carib|heyzo|fc2|pornhub|xvideos|国产自拍|偷拍|偷拍自拍|换妻|自拍偷拍|做爱实录)(\b|$)/i,
        },
      },
      {
        $or: [
          { tags: { $exists: false } },
          {
            tags: {
              $nin: [
                "短剧",
                "微短剧",
                "爽剧",
                "爽文",
                "miniseries",
                "成人",
                "AV",
              ],
            },
          },
        ],
      },
    ]

    // 🔍 关键词搜索
    if (wd) {
      const safeWd = escapeRegex(wd) // ✅ 安全
      const regex = new RegExp(safeWd, "i")
      matchStage.$or = [
        { title: regex },
        { original_title: regex },
        { actors: regex },
        { director: regex },
        { tags: regex },
      ]
    }

    // 📂 分类筛选
    if (cat && cat !== "all") {
      matchStage.category = cat
    }

    // 🌍 地区筛选
    if (area) {
      matchStage.area = new RegExp(area)
    }

    // 📅 年份筛选
    if (year && year !== "全部") {
      const targetYear = parseInt(year)
      if (!isNaN(targetYear)) {
        // 兼容数字和字符串两种存储情况
        andConditions.push({
          $or: [{ year: targetYear }, { year: String(targetYear) }],
        })
        // 如果你的数据库year字段确定全是数字，则保留原样即可
      }
    }

    // ==========================================
    // 2. 标签与特殊模式逻辑
    // ==========================================
    if (tag) {
      const lowerTag = tag.toLowerCase()

      if (lowerTag === "high_score") {
        // 🏆 高分榜单模式 (严格)
        // 1. 评分必须 >= 7.5
        matchStage.rating = { $gte: 7.5 }
        // 2. 必须有一定评分人数 (防止只有1人评10分的片子)
        matchStage.vote_count = { $gte: 20 }
        // 3. 必须是清洗过的数据
        matchStage.tmdb_id = { $exists: true }
      } else if (lowerTag === "netflix") {
        matchStage.tags = { $regex: /netflix/i }
      } else if (["4k", "2160p"].includes(lowerTag)) {
        // 💎 4K 模式
        matchStage.tags = { $in: ["4K", "4k", "2160P"] }
      } else if (
        ["nba", "cba", "f1", "欧冠", "世界杯", "奥运会"].includes(lowerTag)
      ) {
        matchStage.$or = [
          { title: { $regex: new RegExp(tag, "i") } }, // 搜标题
          { tags: { $regex: new RegExp(tag, "i") } }, // 保险起见，也搜一下tag
        ]
      } else {
        // 🏷️ 普通标签 (通用正则匹配，忽略大小写)
        matchStage.tags = { $regex: new RegExp(tag, "i") }
      }
    }
    if (andConditions.length > 0) {
      matchStage.$and = andConditions
    }

    // ==========================================
    // 3. 构建排序逻辑 ($sort)
    // ==========================================
    let sortStage = {}
    let useCompositeSort = false

    // 优先处理明确的排序指令
    if (sort === "rating" || (tag && tag.toLowerCase() === "high_score")) {
      // ⭐ 按评分排序
      sortStage = { rating: -1, year: -1, updatedAt: -1 }

      // 🛡️ 兜底：如果用户没选 high_score 标签，只是点了排序按钮
      // 我们也要过滤掉 0 分的数据，否则排序会很乱
      if (!matchStage.rating) {
        matchStage.rating = { $gt: 0 }
      }
      // 建议：即使是手动排序，也最好过滤掉极少人评分的
      if (!matchStage.vote_count) {
        matchStage.vote_count = { $gt: 0 } // 至少有人评过分
      }
    } else if (sort === "year" || sort === "time") {
      // 📅 时间排序优先使用真实上映日期 (date) 和年份 (year)
      sortStage = { date: -1, year: -1, updatedAt: -1 }
    } else {
      // 🔥 默认综合排序：更新时间 + 热度
      // 热度由 rating + vote_count + 源数量共同决定
      useCompositeSort = true
      sortStage = {
        _composite_score: -1,
        updatedAt: -1,
        vote_count: -1,
        rating: -1,
      }
    }

    // ==========================================
    // 4. 执行聚合查询 (Aggregation)
    // ==========================================
    const projectStage = {
      _id: 1,
      title: 1,
      poster: 1,
      rating: 1,
      year: 1,
      date: 1,
      remarks: 1,
      tags: 1,
      category: 1,
      updatedAt: 1,
      original_title: 1,
      actors: 1,
      director: 1,
    }
    if (shouldSeasonView) {
      projectStage.sources = 1
    }

    const pipeline = [{ $match: matchStage }] // 1. 筛选

    if (useCompositeSort) {
      pipeline.push({
        $addFields: {
          _rating_safe: { $ifNull: ["$rating", 0] },
          _vote_count_safe: { $ifNull: ["$vote_count", 0] },
          _source_count: { $size: { $ifNull: ["$sources", []] } },
          _freshness_score: {
            $max: [
              0,
              {
                $subtract: [
                  100,
                  {
                    $multiply: [
                      {
                        $divide: [
                          {
                            $subtract: [
                              "$$NOW",
                              { $ifNull: ["$updatedAt", new Date(0)] },
                            ],
                          },
                          86400000,
                        ],
                      },
                      2,
                    ],
                  },
                ],
              },
            ],
          },
        },
      })
      pipeline.push({
        $addFields: {
          _composite_score: {
            $add: [
              { $multiply: ["$_rating_safe", 12] },
              { $multiply: [{ $ln: { $add: ["$_vote_count_safe", 1] } }, 4] },
              { $multiply: [{ $min: ["$_source_count", 5] }, 2] },
              "$_freshness_score",
            ],
          },
        },
      })
    }

    pipeline.push({ $sort: sortStage }) // 2. 排序
    pipeline.push({ $skip: wd ? 0 : skip }) // 3. 跳页
    pipeline.push({ $limit: queryLimit }) // 4. 限制数量
    pipeline.push({
      $project: projectStage,
    })

    const list = await Video.aggregate(pipeline)

    // ==========================================
    // 5. 数据格式化 (清洗返回给前端的数据)
    // ==========================================
    let formattedList = list.map((item) => ({
      ...item,
      // 🆔 ID 映射：把 MongoDB 的 _id 对象转为字符串 id
      id: item._id.toString(),
      // 🧹 移除 _id 防止前端混淆 (可选)
      _id: undefined,

      // ⭐ 评分格式化：保留1位小数 (7.56 -> 7.6, 8 -> 8.0由前端处理或保持8)
      rating: toSafeRating(item.rating),
      date: item.date || "",

      // 📅 年份防呆：如果是 2026 这种未来年份，如果不希望显示，可以在这里处理
      // year: item.year > new Date().getFullYear() + 1 ? 0 : item.year
    }))

    if (wd) {
      formattedList = rankSearchResults(formattedList, wd)
      formattedList = formattedList.slice(skip, skip + limit)
    }

    if (shouldSeasonView) {
      const seasonCards = list.flatMap((item) => buildSeasonCards(item))
      if (seasonCards.length > 0) {
        let rankedSeason = seasonCards
        if (wd) {
          rankedSeason = rankSearchResults(seasonCards, wd)
          rankedSeason = rankedSeason.slice(skip, skip + limit)
        }
        formattedList = rankedSeason
      }
    }

    formattedList = formattedList.map((item) => {
      if (!item || !item._search_rank) return item
      const next = { ...item }
      delete next._search_rank
      return next
    })

    // ==========================================
    // 6. 返回结果
    // ==========================================
    res.json({ code: 200, list: formattedList })
  } catch (e) {
    console.error("Search API Error:", e)
    res.status(500).json({ code: 500, msg: "Error" })
  }
}

exports.getHome = async (req, res) => {
  try {
    const homeSeed = buildHomeSeed()
    const fixId = (queryResult) =>
      queryResult.map((item) => {
        const doc = item._doc || item
        return {
          ...doc,
          id: doc.uniq_id || doc.id || doc._id,
          remarks: doc.remarks || doc.latest_remarks || "",
          rating: toSafeRating(doc.rating),
        }
      })

    // 首页接口不需要携带 sources（包含大量播放串），否则响应体会非常大、首屏变慢
    const baseSelect =
      "_id title poster backdrop remarks latest_remarks year rating vote_count tags category area updatedAt"

    const [heroPoolRaw, latestTvRaw, latestMovieRaw, highTvRaw, highMovieRaw] =
      await Promise.all([
        Video.find({
          title: { $not: /短剧|微短剧|爽剧|爽文|赘婿|miniseries/i },
          category: { $in: ["movie", "tv", "anime"] },
        })
          .sort({ rating: -1, vote_count: -1, updatedAt: -1 })
          .limit(80)
          .select(baseSelect)
          .lean(),
        Video.find({
          title: { $not: /短剧|微短剧|爽剧|爽文|赘婿|miniseries/i },
          category: "tv",
          year: { $gte: 2000 },
        })
          .sort({ updatedAt: -1, vote_count: -1, rating: -1 })
          .limit(120)
          .select(baseSelect)
          .lean(),
        Video.find({
          title: { $not: /短剧|微短剧|爽剧|爽文|赘婿|miniseries/i },
          category: "movie",
          year: { $gte: 2000 },
        })
          .sort({ updatedAt: -1, vote_count: -1, rating: -1 })
          .limit(120)
          .select(baseSelect)
          .lean(),
        Video.find({
          title: { $not: /短剧|微短剧|爽剧|爽文|赘婿|miniseries/i },
          category: "tv",
          rating: { $gte: 7.2 },
          vote_count: { $gte: 20 },
        })
          .sort({ rating: -1, vote_count: -1, updatedAt: -1 })
          .limit(80)
          .select(baseSelect)
          .lean(),
        Video.find({
          title: { $not: /短剧|微短剧|爽剧|爽文|赘婿|miniseries/i },
          category: "movie",
          rating: { $gte: 7.2 },
          vote_count: { $gte: 20 },
        })
          .sort({ rating: -1, vote_count: -1, updatedAt: -1 })
          .limit(80)
          .select(baseSelect)
          .lean(),
      ])

    const heroPool = heroPoolRaw.filter(isHighQualityHomeItem)
    const latestTvPool = latestTvRaw.filter(isHighQualityHomeItem)
    const latestMoviePool = latestMovieRaw.filter(isHighQualityHomeItem)
    const highTvPool = highTvRaw.filter(isHighQualityHomeItem)
    const highMoviePool = highMovieRaw.filter(isHighQualityHomeItem)

    const heroCandidates = uniqById([
      ...heroPool,
      ...latestTvPool,
      ...latestMoviePool,
    ])
    const banners = rotateList(heroCandidates, homeSeed).slice(0, 8)
    const used = new Set(banners.map((x) => String(x._id)))

    const latestTvPicked = pickUniqueFromPool(
      latestTvPool,
      used,
      14,
      homeSeed + 11,
      { keepOrder: true },
    )
    const latestMoviePicked = pickUniqueFromPool(
      latestMoviePool,
      used,
      14,
      homeSeed + 23,
      { keepOrder: true },
    )
    const highTvPicked = pickUniqueFromPool(highTvPool, used, 14, homeSeed + 31)
    const highMoviePicked = pickUniqueFromPool(
      highMoviePool,
      used,
      14,
      homeSeed + 41,
    )

    const sections = [
      { title: "最新热门剧集", type: "scroll", data: fixId(latestTvPicked) },
      { title: "最新热门电影", type: "scroll", data: fixId(latestMoviePicked) },
      { title: "高分口碑剧集", type: "scroll", data: fixId(highTvPicked) },
      { title: "高分口碑电影", type: "scroll", data: fixId(highMoviePicked) },
    ].filter((section) => section.data.length > 0)

    res.json({
      code: 200,
      data: {
        banners: fixId(banners),
        sections,
      },
    })
  } catch (e) {
    res.status(500).json({ code: 500, msg: e.message })
  }
}

exports.getDetail = async (req, res) => {
  const { id } = req.params // 可能是 "65a4f..." (_id) 或 "maotai_123" (旧ID)

  // 1. 缓存检查 (缓存 10 分钟)
  const cacheKey = `detail_v5_${id}`
  const cachedData = await getCache(cacheKey)

  // 辅助函数：标准化返回
  const success = (res, data) =>
    res.json({ code: 200, message: "success", data })
  const fail = (res, msg = "Error", code = 500) =>
    res.json({ code, message: msg })

  if (cachedData) return success(res, cachedData)

  try {
    let video = null

    // ==========================================
    // 步骤 A: 优先尝试 MongoDB _id 查询 (新架构标准)
    // ==========================================
    // 只有当 id 是 24位 hex 字符串时才尝试，避免报错
    if (mongoose.Types.ObjectId.isValid(id)) {
      video = await Video.findById(id)
    }

    // ==========================================
    // 步骤 B: 如果没找到，尝试兼容旧 ID 查询
    // ==========================================
    if (!video) {
      // 旧逻辑：可能是 "maotai_12345" 这种格式
      // 或者在 sources 数组里查找子文档的 vod_id
      video = await Video.findOne({
        $or: [
          { uniq_id: id }, // 匹配旧版 Flat 数据
          { "sources.vod_id": id }, // 匹配聚合后的子资源 ID
          { custom_id: id }, // 匹配自定义 ID (如果有)
        ],
      })
    }

    // ==========================================
    // 步骤 C: 还是没找到？ -> 404
    // ==========================================
    // ⚠️ 我们已经移除了“回源采集”逻辑，因为：
    // 1. 你现在是全量采集模式，数据库理应有数据。
    // 2. 拿 MongoDB ID 去请求资源站接口会导致 crash。
    // 3. 避免了恶意用户乱输 ID 导致服务器卡顿。
    if (!video) {
      console.warn(`⚠️ [Detail] Not Found: ${id}`)
      return fail(res, "资源未找到或已下架", 404)
    }

    // ==========================================
    // 步骤 D: 格式化数据并返回
    // ==========================================
    const result = formatDetail(video)
    result.sources = await enrichAndSortSources(result.sources)

    // 写入缓存
    await setCache(cacheKey, result, 600)

    success(res, result)
  } catch (e) {
    console.error(`🔥 [Detail] Error processing ID: ${id}`, e)
    fail(res, "服务器内部错误: " + e.message)
  }
}

const normalizeSourceTitle = (raw = "") =>
  String(raw)
    .replace(/[《》“”"'·]/g, "")
    .replace(/\s+/g, " ")
    .replace(/第\s*[一二两三四五六七八九十百\d]+\s*[季部]/gi, "")
    .replace(/Season\s*\d+/gi, "")
    .replace(/S\d{1,2}/gi, "")
    .trim()
    .toLowerCase()

const isStrictSourceMatch = (queryTitle = "", candidateTitle = "") => {
  const q = normalizeSourceTitle(queryTitle)
  const c = normalizeSourceTitle(candidateTitle)
  if (!q || !c) return false
  if (q === c) return true

  // 只允许“同名+附加后缀”类匹配，避免命中过多包含词
  if (c.startsWith(q)) {
    const tail = c.slice(q.length)
    if (!tail) return true
    if (/^[\s:：\-—_·.()（）\[\]【】0-9一二两三四五六七八九十季部全第集完结版]+$/i.test(tail)) {
      return true
    }
  }

  return false
}

exports.searchSources = async (req, res) => {
  const { title } = req.query

  if (!title) return fail(res, "缺少标题参数", 400)

  // 1. 缓存检查 (防止短时间重复搜同一个词炸接口)
  const cacheKey = `sources_search_v2_${encodeURIComponent(title)}`
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    // 2. 获取所有配置的源 keys
    const allSourceKeys = Object.keys(sources)

    // 3. 并发请求所有源
    // 使用 Promise.allSettled 也可以，这里用 map + catch 保证一个挂了不影响其他
    const searchPromises = allSourceKeys.map(async (key) => {
      const sourceConfig = sources[key]
      try {
        // 请求资源站: ac=detail 才能拿到播放地址
        const response = await axios.get(sourceConfig.url, {
          params: { ac: "detail", wd: title },
          ...getAxiosConfig({ timeout: 6000 }),
        })

        const list = response.data?.list || []

        // 4. 过滤与匹配逻辑
        // 资源站搜索是模糊的，我们需要过滤掉不相关的
        const matchedItems = list.filter((item) =>
          isStrictSourceMatch(title, item?.vod_name || ""),
        )
        const validItems = []
        for (const item of matchedItems) {
          const adult = evaluateAdultContent(item, key)
          if (adult.blocked) continue
          const judge = await shouldBlockShortDrama(item, key)
          if (!judge.blocked) validItems.push(item)
        }

        // 5. 格式化返回数据
        return validItems.map((item) => ({
          // 构造临时 ID (格式: feifan_12345)
          id: `${key}_${item.vod_id}`,
          source_key: key,
          source_name: sourceConfig.name, // 显示 "非凡资源"

          // 🔥 关键：返回具体标题，方便用户区分是 "第一季" 还是 "第二季"
          title: item.vod_name,

          // 🔥 关键：返回播放地址，前端点击即播，无需再查
          vod_play_url: item.vod_play_url,
          remarks: item.vod_remarks,

          // 标记类型
          type: "external",
        }))
      } catch (err) {
        // console.warn(`源 ${sourceConfig.name} 搜索超时或失败`);
        return [] // 失败返回空数组，不影响整体
      }
    })

    const results = await Promise.all(searchPromises)

    // 拍平数组
    let availableSources = results.flat()

    if (availableSources.length === 0) {
      return success(res, [])
    }

    const normalizeSearchTitle = (raw = "") =>
      String(raw)
        .replace(/（.*?）|\(.*?\)/g, "")
        .replace(/\s+/g, " ")
        .replace(/第\s*[一二两三四五六七八九十百\d]+\s*[季部]/gi, "")
        .replace(/Season\s*\d+/gi, "")
        .replace(/S\d{1,2}/gi, "")
        .trim()

    const expectedBase = normalizeSearchTitle(title).toLowerCase()

    // 先按剧名聚合相似度 -> 再按季数 -> 再按线路优先级
    availableSources.sort((a, b) => {
      const titleA = String(a.title || "")
      const titleB = String(b.title || "")
      const baseA = normalizeSearchTitle(titleA).toLowerCase()
      const baseB = normalizeSearchTitle(titleB).toLowerCase()

      const exactA = expectedBase && baseA === expectedBase ? 0 : 1
      const exactB = expectedBase && baseB === expectedBase ? 0 : 1
      if (exactA !== exactB) return exactA - exactB

      const containA = expectedBase && baseA.includes(expectedBase) ? 0 : 1
      const containB = expectedBase && baseB.includes(expectedBase) ? 0 : 1
      if (containA !== containB) return containA - containB

      const seasonA = parseSeasonInfo(titleA)?.season_no ?? Number.MAX_SAFE_INTEGER
      const seasonB = parseSeasonInfo(titleB)?.season_no ?? Number.MAX_SAFE_INTEGER
      if (seasonA !== seasonB) return seasonA - seasonB

      let indexA = PRIORITY_LIST.indexOf(a.source_key)
      let indexB = PRIORITY_LIST.indexOf(b.source_key)
      if (indexA === -1) indexA = 999
      if (indexB === -1) indexB = 999
      if (indexA !== indexB) return indexA - indexB

      return titleA.localeCompare(titleB, "zh-Hans-CN")
    })

    // 存入缓存
    await setCache(cacheKey, availableSources, 600)

    success(res, availableSources)
  } catch (e) {
    console.error("Search Sources Error:", e)
    fail(res, "搜索源失败")
  }
}

exports.matchResource = async (req, res) => {
  const { tmdb_id, category, title, year } = req.query

  const success = (res, data) =>
    res.json({ code: 200, message: "success", data })
  const fail = (res, msg = "Error", code = 500) =>
    res.json({ code, message: msg })

  if (!tmdb_id && !title) {
    return fail(res, "缺少匹配参数", 400)
  }

  try {
    let video = null

    // ==========================================
    // 🎯 策略 A: TMDB ID 精准匹配
    // ==========================================
    if (tmdb_id) {
      // 1. 先判断是不是误传了 MongoDB 的 _id (24位 hex 字符串)
      // 如果是，直接按 _id 找，不用再匹配了
      if (/^[0-9a-fA-F]{24}$/.test(tmdb_id)) {
        try {
          video = await Video.findById(tmdb_id)
          if (video)
            console.log(`[Match] 通过 MongoID 直接命中: ${video.title}`)
        } catch (e) {}
      }

      // 2. 如果没找到，再当做 TMDB ID (数字) 去找
      if (!video) {
        const tmdbIdNum = parseInt(tmdb_id)
        if (!isNaN(tmdbIdNum)) {
          video = await Video.findOne({ tmdb_id: tmdbIdNum })
        }
      }
    }

    // ==========================================
    // 🔎 策略 B: 智能模糊匹配 (核心优化)
    // ==========================================
    if (!video && title) {
      // 🛠️ 1. 标题清洗：移除 "第二季", "Season 2", "Netflix" 等干扰词，提高命中率
      const cleanTitle = title
        .replace(/（.*?）|\(.*?\)/g, "") // 去括号
        .replace(/(第.季|Season \d+|Netflix|4K|1080P)/gi, "") // 去修饰词
        .trim()

      console.log(
        `[Match] 原始: ${title} -> 清洗后: ${cleanTitle} (Cat: ${category})`,
      )

      const query = {}

      // 🛠️ 2. 标题模糊查询 (Regex)
      // 使用正则包含匹配，且忽略大小写
      // 对正则特殊字符进行转义，防止报错
      const safeTitle = cleanTitle.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
      query.title = { $regex: new RegExp(safeTitle, "i") }

      // 🛠️ 3. 分类智能映射 (解决 tv != 日本动漫 的问题)
      if (category && category !== "all") {
        const catMap = {
          // 只要前端传了 movie，就在这些中文分类里找
          movie: [
            "电影",
            "动作",
            "科幻",
            "爱情",
            "喜剧",
            "恐怖",
            "剧情",
            "战争",
            "灾难",
            "Netflix",
          ],
          // 只要前端传了 tv，就在这些中文分类里找
          tv: [
            "剧集",
            "国产",
            "欧美",
            "韩剧",
            "日剧",
            "日本",
            "动漫",
            "日本动漫",
            "海外",
            "Netflix",
          ],
          anime: ["动漫", "日本动漫", "国产动漫"],
          variety: ["综艺", "大陆综艺", "日韩综艺"],
        }

        // 如果映射表里有，就用 $in 查询；如果没有，就模糊匹配一下
        const targetCats = catMap[category]
        if (targetCats) {
          // 搜 category 字段 或者 tags 字段
          query.$or = [
            { category: { $in: targetCats } },
            { tags: { $in: targetCats } }, // 有时候分类标错了，但标签是对的
          ]
        } else {
          // 兜底：如果传了未知的分类，尝试模糊匹配
          query.category = { $regex: new RegExp(category, "i") }
        }
      }

      // 🔒 4. 年份模糊校验 (保持原样，这逻辑挺好)
      if (year) {
        const y = parseInt(year)
        if (!isNaN(y)) {
          // 如果前面有 $or 查询，这里必须小心合并
          // 使用 $and 确保年份限制对 $or 里的条件都生效
          const yearQuery = { year: { $gte: y - 1, $lte: y + 1 } }
          if (query.$or) {
            query.$and = [yearQuery, { $or: query.$or }]
            delete query.$or // 移入 $and
          } else {
            query.year = yearQuery.year
          }
        }
      }

      // 🔒 5. 黑名单 (保持原样)
      query.original_type = { $not: /短剧|爽文|爽剧/ }

      // 执行查询，优先找 rating 高的，或者最近更新的
      video = await Video.findOne(query).sort({ updatedAt: -1 })
    }

    // ==========================================
    // 🚀 结果提取
    // ==========================================
    if (video) {
      // (保持原有的提取 source 和 episode 逻辑不变)
      let finalEpisodeCount = 0
      let finalPlayFrom = "unknown"

      if (video.sources && video.sources.length > 0) {
        const firstSource = video.sources[0]
        finalPlayFrom = firstSource.source_key
        finalEpisodeCount = firstSource.vod_play_url
          ? firstSource.vod_play_url.split("#").length
          : 0
      } else if (video.vod_play_url) {
        finalPlayFrom = video.source || "unknown"
        finalEpisodeCount = video.vod_play_url.split("#").length
      }

      // 只要找到了，不管有没有播放源，先返回 found: true
      // (有些资源可能暂时没集数，但至少匹配到了详情)
      return success(res, {
        found: true,
        id: video._id.toString(),
        title: video.title,
        source: finalPlayFrom,
        episodes_count: finalEpisodeCount,
        year: video.year,
        // 告诉前端匹配到了什么分类，方便调试
        matched_category: video.category,
      })
    }

    return success(res, { found: false, message: "本地库暂未收录" })
  } catch (e) {
    console.error("Match Error:", e)
    return fail(res, "匹配异常")
  }
}

exports.ingestVideo = async (req, res) => {
  const { title } = req.body
  if (!title) return res.json({ code: 400, message: "缺少影片名称" })

  try {
    // 1. 先查本地库是否已经有了 (防止用户重复点击)
    const safeTitle = title.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
    const existVideo = await Video.findOne({
      title: { $regex: new RegExp(safeTitle, "i") },
    })

    if (existVideo) {
      return res.json({
        code: 200,
        message: "该影片已在片库中",
        id: existVideo._id.toString(),
      })
    }

    console.log(`\n================================`)
    console.log(`[Ingest] 🚀 触发一键采录: 关键词【${title}】`)

    // 2. 去全网资源站进行搜索
    const allSourceKeys = Object.keys(sources)
    const searchPromises = allSourceKeys.map(async (key) => {
      const sourceConfig = sources[key]
      try {
        const response = await axios.get(sourceConfig.url, {
          params: { ac: "detail", wd: title },
          ...getAxiosConfig({ timeout: 8000 }),
        })
        const list = response.data?.list || []

        // 🔥 核心修复 1：双向模糊匹配，忽略大小写
        const matchedItems = list.filter((item) => {
          const vName = item.vod_name.toLowerCase()
          const tName = title.toLowerCase()
          // 只要资源站的名字包含搜索词，或者搜索词包含资源站名字，都算命中！
          return vName.includes(tName) || tName.includes(vName)
        })
        const validItems = []
        for (const item of matchedItems) {
          const adult = evaluateAdultContent(item, key)
          if (adult.blocked) continue
          const judge = await shouldBlockShortDrama(item, key)
          if (!judge.blocked) validItems.push(item)
        }

        if (validItems.length > 0) {
          console.log(
            `[Ingest] ✅ ${sourceConfig.name} 命中 ${validItems.length} 条资源`,
          )
        }

        return validItems.map((item) => ({
          ...item,
          source_key: key,
        }))
      } catch (err) {
        // 🔥 核心修复 2：把真正的报错原因打印出来
        console.error(`[Ingest] ❌ ${sourceConfig.name} 请求失败:`, err.message)
        return []
      }
    })

    const results = await Promise.all(searchPromises)
    const availableSources = results.flat()

    if (availableSources.length === 0) {
      console.log(`[Ingest] 🚫 采录失败: 全网均未搜到【${title}】`)
      return res.json({ code: 404, message: "抱歉，全网暂未找到该影视资源" })
    }

    // 🔥 核心修复 3：按照配置的优先级 (feifan > liangzi) 重新洗牌
    availableSources.sort((a, b) => {
      let indexA = PRIORITY_LIST.indexOf(a.source_key)
      let indexB = PRIORITY_LIST.indexOf(b.source_key)
      if (indexA === -1) indexA = 999
      if (indexB === -1) indexB = 999
      return indexA - indexB
    })

    // 取最靠谱的第一个源进行本地格式化入库
    const bestMatch = availableSources[0]
    console.log(
      `[Ingest] 🌟 准备入库最优解: 【${bestMatch.vod_name}】(源自: ${bestMatch.source_key})`,
    )

    // 简单智能分类映射
    let localCategory = "movie"
    const typeName = bestMatch.type_name || ""
    if (typeName.includes("剧")) localCategory = "tv"
    else if (typeName.includes("综艺") || typeName.includes("晚会"))
      localCategory = "variety"
    else if (typeName.includes("动漫") || typeName.includes("动画"))
      localCategory = "anime"

    const newVideo = new Video({
      title: bestMatch.vod_name,
      poster: bestMatch.vod_pic,
      category: localCategory,
      year: bestMatch.vod_year,
      area: bestMatch.vod_area,
      content: bestMatch.vod_content,
      actors: bestMatch.vod_actor,
      director: bestMatch.vod_director,
      remarks: bestMatch.vod_remarks,
      sources: [
        {
          source_key: bestMatch.source_key,
          vod_id: bestMatch.vod_id,
          vod_name: bestMatch.vod_name,
          vod_play_from: bestMatch.vod_play_from,
          vod_play_url: bestMatch.vod_play_url,
          remarks: bestMatch.vod_remarks,
        },
      ],
    })

    await newVideo.save()
    console.log(`[Ingest] 🎉 入库成功，MongoDB ID: ${newVideo._id}`)

    return res.json({
      code: 200,
      message: "🎉 收录成功！",
      id: newVideo._id.toString(),
    })
  } catch (e) {
    console.error("[Ingest Error] 致命错误:", e)
    return res.json({ code: 500, message: "服务器收录时发生异常" })
  }
}

exports.ingestVideoBySource = async (req, res) => {
  const source_key = String(req.body?.source_key || "").trim()
  const vod_id = String(req.body?.vod_id || "").trim()
  if (!source_key || !vod_id) {
    return res.json({ code: 400, message: "缺少 source_key 或 vod_id" })
  }
  if (!sources[source_key]) {
    return res.json({ code: 400, message: "未知资源站" })
  }

  try {
    const existVideo = await Video.findOne({
      sources: { $elemMatch: { source_key, vod_id } },
    })
    if (existVideo) {
      return res.json({
        code: 200,
        message: "该资源已在片库中",
        id: existVideo._id.toString(),
      })
    }

    const sourceConfig = sources[source_key]
    let list = []
    try {
      const response = await axios.get(sourceConfig.url, {
        params: { ac: "detail", ids: vod_id },
        ...getAxiosConfig({ timeout: 8000 }),
      })
      list = response.data?.list || []
    } catch (e) {
      list = []
    }
    if (!Array.isArray(list) || list.length === 0) {
      const response = await axios.get(sourceConfig.url, {
        params: { ac: "detail", wd: vod_id },
        ...getAxiosConfig({ timeout: 8000 }),
      })
      list = response.data?.list || []
    }

    const picked =
      list.find((x) => String(x?.vod_id || "") === vod_id) || list[0] || null
    if (!picked) {
      return res.json({ code: 404, message: "源站未返回该资源" })
    }

    const adult = evaluateAdultContent(picked, source_key)
    if (adult.blocked) {
      return res.json({ code: 404, message: "资源不可用" })
    }
    const judge = await shouldBlockShortDrama(picked, source_key)
    if (judge.blocked) {
      return res.json({ code: 404, message: "资源不可用" })
    }

    let localCategory = "movie"
    const typeName = picked.type_name || ""
    if (typeName.includes("剧")) localCategory = "tv"
    else if (typeName.includes("综艺") || typeName.includes("晚会"))
      localCategory = "variety"
    else if (typeName.includes("动漫") || typeName.includes("动画"))
      localCategory = "anime"

    const newVideo = new Video({
      title: picked.vod_name,
      poster: picked.vod_pic,
      category: localCategory,
      year: picked.vod_year,
      area: picked.vod_area,
      content: picked.vod_content,
      actors: picked.vod_actor,
      director: picked.vod_director,
      remarks: picked.vod_remarks,
      sources: [
        {
          source_key,
          vod_id: picked.vod_id,
          vod_name: picked.vod_name,
          vod_play_from: picked.vod_play_from,
          vod_play_url: picked.vod_play_url,
          remarks: picked.vod_remarks,
        },
      ],
    })

    await newVideo.save()
    return res.json({
      code: 200,
      message: "🎉 收录成功！",
      id: newVideo._id.toString(),
    })
  } catch (e) {
    console.error("[Ingest By Source Error]", e?.message || e)
    return res.json({ code: 500, message: "服务器收录时发生异常" })
  }
}
