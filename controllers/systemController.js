const { smartFetch } = require("../services/videoService")
const { getCache, setCache } = require("../utils/cache")
const { STANDARD_GROUPS, BLACK_LIST } = require("../config/constants")
const { OpenAI } = require("openai")
const Video = require("../models/Video")
const axios = require("axios")

// 1. 初始化大模型客户端 (统一使用 OpenAI 规范调用千问)
const openai = new OpenAI({
  apiKey: process.env.QWEN_API_KEY || process.env.ZHIPU_API_KEY || "EMPTY_KEY",
  baseURL: process.env.QWEN_API_KEY
    ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
    : "https://open.bigmodel.cn/api/paas/v4/",
})

// 2. 统一响应封装
const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

const escapeRegex = (value = "") =>
  String(value).replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")

const extractRawQuestion = (question = "") => {
  const quoted =
    question.match(/用户输入了以下内容：[“"](.+?)[”"]/)?.[1] ||
    question.match(/以下内容[：:][“"](.+?)[”"]/)?.[1]
  const raw = (quoted || question).trim()
  return raw
    .replace(/现在，请直接输出你的结果[:：]?/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

const inferCategory = (question = "") => {
  if (/动漫|动画|番剧/i.test(question)) return "anime"
  if (/综艺|真人秀|脱口秀|晚会/i.test(question)) return "variety"
  if (/体育|nba|欧冠|世界杯|f1|英超/i.test(question)) return "sports"
  if (/剧|电视剧|美剧|韩剧|日剧/i.test(question)) return "tv"
  if (/电影|院线|影片|片子/i.test(question)) return "movie"
  return null
}

const buildCategoryFilter = (categoryHint) => {
  if (!categoryHint) return null
  const map = {
    movie: ["movie", "电影", "影片", "院线", "动作片"],
    tv: ["tv", "剧集", "电视剧", "连续剧", "美剧", "韩剧", "日剧"],
    anime: ["anime", "动漫", "动画", "番剧"],
    variety: ["variety", "综艺", "真人秀"],
    sports: ["sports", "体育", "赛事"],
  }
  const aliases = map[categoryHint] || [categoryHint]
  return { $in: aliases }
}

const extractPersonHint = (question = "") => {
  const match =
    String(question).match(/推荐(?:几部|一些|点)?\s*([^，。！？\s]{2,12}?)(?:演的|导演的|主演的)?(?:剧|电影|作品)/i) ||
    String(question).match(/([^，。！？\s]{2,12}?)(?:演的|导演的|主演的)/i) ||
    String(question).match(/([^，。！？\s]{2,12}?)的(?:剧|电影|作品)/i)
  if (!match) return ""
  const person = String(match[1] || "").trim()
  if (person.length < 2 || person.length > 8) return ""
  return person.replace(/[^\u4e00-\u9fa5a-zA-Z·\s]/g, "").trim()
}

const isPersonIntent = (question = "") =>
  /(演的|导演|主演|演员|的剧|的电影|作品)/i.test(String(question))

const isRecommendationIntent = (question = "") =>
  /(推荐|高分|近期|最新|好看|必看|热门|榜单)/i.test(String(question))

const searchLocalCandidates = async (queryText, categoryHint) => {
  const safeQuery = escapeRegex(queryText)
  const recommendationMode = isRecommendationIntent(queryText)
  const personHint = extractPersonHint(queryText)
  if (!safeQuery && !recommendationMode) return []

  const findQuery = {}

  if (!recommendationMode) {
    const regex = new RegExp(safeQuery, "i")
    findQuery.$or = [
      { title: regex },
      { original_title: regex },
      { actors: regex },
      { director: regex },
      { tags: regex },
    ]
  }

  const categoryFilter = buildCategoryFilter(categoryHint)
  if (categoryFilter) {
    findQuery.category = categoryFilter
  }

  if (personHint) {
    const personRegex = new RegExp(escapeRegex(personHint), "i")
    findQuery.$or = [
      ...(findQuery.$or || []),
      { actors: personRegex },
      { director: personRegex },
      { title: personRegex },
    ]
  }

  if (/韩剧|韩国/i.test(queryText)) {
    findQuery.$or = [
      ...(findQuery.$or || []),
      { area: /韩国|韩/i },
      { tags: /韩剧|韩国/i },
      { title: /韩/i },
    ]
  }

  if (/美剧|欧美/i.test(queryText)) {
    findQuery.$or = [
      ...(findQuery.$or || []),
      { area: /美国|欧美/i },
      { tags: /美剧|欧美/i },
    ]
  }

  const rows = await Video.find(findQuery)
    .sort({ rating: -1, updatedAt: -1 })
    .limit(24)
    .select("title year category rating tags updatedAt")
    .lean()

  return rows.map((item, index) => ({
    id: `local_${index}`,
    title: item.title,
    year: item.year || "",
    category: item.category || "",
    rating: typeof item.rating === "number" ? item.rating : 0,
    source: "local",
  }))
}

const searchTmdbCandidates = async (queryText, categoryHint) => {
  if (!process.env.TMDB_API_KEY || !queryText) return []
  const tmdbCategoryFilter =
    categoryHint === "movie" || categoryHint === "tv" ? categoryHint : null
  const recommendationMode = isRecommendationIntent(queryText)
  const personHint = extractPersonHint(queryText)
  try {
    if (personHint) {
      const personRes = await axios.get("https://api.themoviedb.org/3/search/person", {
        params: {
          api_key: process.env.TMDB_API_KEY,
          query: personHint,
          language: "zh-CN",
          page: 1,
          include_adult: false,
        },
        timeout: 6000,
      })
      const person = Array.isArray(personRes.data?.results)
        ? personRes.data.results[0]
        : null
      if (person?.id) {
        const creditsRes = await axios.get(
          `https://api.themoviedb.org/3/person/${person.id}/combined_credits`,
          {
            params: {
              api_key: process.env.TMDB_API_KEY,
              language: "zh-CN",
            },
            timeout: 6000,
          },
        )
        const castList = Array.isArray(creditsRes.data?.cast)
          ? creditsRes.data.cast
          : []
        const mapped = castList
          .filter((item) => ["movie", "tv"].includes(item.media_type))
          .filter(
            (item) =>
              !tmdbCategoryFilter || item.media_type === tmdbCategoryFilter,
          )
          .sort((a, b) => Number(b.vote_average || 0) - Number(a.vote_average || 0))
          .slice(0, 16)
          .map((item, index) => ({
            id: `tmdb_person_${index}`,
            title: item.title || item.name,
            year:
              (item.release_date || item.first_air_date || "").slice(0, 4) || "",
            category: item.media_type || "",
            rating: Number(item.vote_average || 0),
            source: "tmdb",
          }))
        if (mapped.length > 0) return mapped
      }
    }

    if (
      recommendationMode &&
      (tmdbCategoryFilter === "tv" || /韩剧|韩国/i.test(queryText))
    ) {
      const discoverRes = await axios.get(
        "https://api.themoviedb.org/3/discover/tv",
        {
          params: {
            api_key: process.env.TMDB_API_KEY,
            language: "zh-CN",
            sort_by: "vote_average.desc",
            vote_count_gte: 150,
            with_origin_country: /韩剧|韩国/i.test(queryText)
              ? "KR"
              : undefined,
            page: 1,
          },
          timeout: 6000,
        },
      )
      const discoverList = Array.isArray(discoverRes.data?.results)
        ? discoverRes.data.results
        : []
      return discoverList.slice(0, 12).map((item, index) => ({
        id: `tmdb_discover_${index}`,
        title: item.name || item.title,
        year: (item.first_air_date || "").slice(0, 4) || "",
        category: "tv",
        rating: Number(item.vote_average || 0),
        source: "tmdb",
      }))
    }

    const res = await axios.get("https://api.themoviedb.org/3/search/multi", {
      params: {
        api_key: process.env.TMDB_API_KEY,
        query: queryText,
        language: "zh-CN",
        include_adult: false,
        page: 1,
      },
      timeout: 6000,
    })

    const list = Array.isArray(res.data?.results) ? res.data.results : []
    return list
      .filter((item) => ["movie", "tv"].includes(item.media_type))
      .filter(
        (item) => !tmdbCategoryFilter || item.media_type === tmdbCategoryFilter,
      )
      .slice(0, 12)
      .map((item, index) => ({
        id: `tmdb_${index}`,
        title: item.title || item.name,
        year:
          (item.release_date || item.first_air_date || "").slice(0, 4) || "",
        category: item.media_type || "",
        rating: Number(item.vote_average || 0),
        source: "tmdb",
      }))
  } catch (error) {
    return []
  }
}

const dedupeCandidates = (items = []) => {
  const map = new Map()
  for (const item of items) {
    const key = `${item.title || ""}_${item.year || ""}`.toLowerCase()
    if (!key.trim() || map.has(key)) continue
    map.set(key, item)
  }
  return Array.from(map.values())
}

const normalizeTitle = (value = "") =>
  String(value)
    .replace(/[《》"'`]/g, "")
    .replace(/^\d+[.)、\s-]*/, "")
    .replace(/[。！？!?.]+$/g, "")
    .trim()

const splitPotentialTitles = (value = "") =>
  String(value)
    .split(/[，,、\n;；]/)
    .map((item) => normalizeTitle(item))
    .filter(Boolean)

const looksLikeGarbage = (title = "") => {
  if (!title) return true
  if (title.length < 2 || title.length > 40) return true
  if (/^\d+$/.test(title)) return true
  if (
    /(无法|联网|实时|根据|推测|以下|信息|数据|建议|推荐|评分|前的信息|系统|结果|格式|输出)/i.test(
      title,
    )
  ) {
    return true
  }
  return false
}

const sanitizeTitleList = (items = []) => {
  const unique = new Set()
  const result = []

  for (const raw of items) {
    const parts = splitPotentialTitles(raw)
    for (const part of parts) {
      if (looksLikeGarbage(part)) continue
      const key = part.toLowerCase()
      if (unique.has(key)) continue
      unique.add(key)
      result.push(part)
    }
  }

  return result
}

const fallbackRank = (candidates = []) =>
  [...candidates]
    .sort((a, b) => {
      const sourceA = a.source === "local" ? 0 : 1
      const sourceB = b.source === "local" ? 0 : 1
      if (sourceA !== sourceB) return sourceA - sourceB
      const ratingA = typeof a.rating === "number" ? a.rating : 0
      const ratingB = typeof b.rating === "number" ? b.rating : 0
      return ratingB - ratingA
    })
    .slice(0, 8)

const rerankByModel = async (question, candidates) => {
  const hasModelAuth = !!(process.env.QWEN_API_KEY || process.env.ZHIPU_API_KEY)
  if (!hasModelAuth || candidates.length === 0) {
    return fallbackRank(candidates)
  }

  const compactCandidates = candidates.map((item, index) => ({
    idx: index,
    title: item.title,
    year: item.year,
    category: item.category,
    rating: item.rating,
    source: item.source,
  }))

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.QWEN_API_KEY ? "qwen-plus" : "glm-4-flash",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "你是影视检索重排器。你只能从候选集中挑选，不得编造。仅输出 JSON 数组，数组元素是候选 idx 数字。",
        },
        {
          role: "user",
          content: JSON.stringify({
            question,
            instruction:
              "按用户意图排序，最多返回8个idx。没有合适结果返回空数组。",
            candidates: compactCandidates,
          }),
        },
      ],
    })

    const text = completion?.choices?.[0]?.message?.content || "[]"
    const jsonStr = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)
    const idxs = JSON.parse(jsonStr)
    if (!Array.isArray(idxs)) throw new Error("Invalid model output")

    const picked = idxs
      .map((idx) => candidates[Number(idx)])
      .filter(Boolean)
      .slice(0, 8)

    return picked.length > 0 ? picked : fallbackRank(candidates)
  } catch (error) {
    return fallbackRank(candidates)
  }
}

// ==========================================
// 业务逻辑 1: 获取并清洗分类 (保持你原有的逻辑不变)
// ==========================================
exports.getCategories = async (req, res) => {
  const cacheKey = "categories_auto_washed_v2"
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    const result = await smartFetch(() => ({ ac: "list", at: "json" }))
    if (!result || !result.data || !result.data.class)
      throw new Error("No data")

    const rawList = result.data.class
    const washedList = [
      { type_id: 1, type_pid: 0, type_name: "电影" },
      { type_id: 2, type_pid: 0, type_name: "剧集" },
      { type_id: 3, type_pid: 0, type_name: "综艺" },
      { type_id: 4, type_pid: 0, type_name: "动漫" },
      { type_id: 5, type_pid: 0, type_name: "体育" },
    ]

    rawList.forEach((item) => {
      const name = item.type_name
      const id = parseInt(item.type_id)

      if (BLACK_LIST.some((bad) => name.includes(bad))) return
      if (["电影", "电视剧", "连续剧", "综艺", "动漫", "体育"].includes(name))
        return

      let targetPid = 0

      if (STANDARD_GROUPS.SPORTS.regex.test(name)) targetPid = 5
      else if (STANDARD_GROUPS.ANIME.regex.test(name)) targetPid = 4
      else if (STANDARD_GROUPS.VARIETY.regex.test(name)) targetPid = 3
      else if (STANDARD_GROUPS.TV.regex.test(name)) targetPid = 2
      else if (STANDARD_GROUPS.MOVIE.regex.test(name)) targetPid = 1

      if (targetPid === 0) {
        if (id >= 6 && id <= 12) targetPid = 1
        else if (id >= 13 && id <= 24) targetPid = 2
        else if (id >= 25 && id <= 29) targetPid = 3
        else if (id >= 30 && id <= 34) targetPid = 4
        else targetPid = 999
      }

      washedList.push({ type_id: id, type_name: name, type_pid: targetPid })
    })

    await setCache(cacheKey, washedList, 86400)
    success(res, washedList)
  } catch (e) {
    console.error("Categories Fetch Error:", e)
    success(res, [
      { type_id: 1, type_pid: 0, type_name: "电影" },
      { type_id: 2, type_pid: 0, type_name: "剧集" },
      { type_id: 3, type_pid: 0, type_name: "综艺" },
      { type_id: 4, type_pid: 0, type_name: "动漫" },
    ])
  }
}

exports.askAI = async (req, res) => {
  const { question } = req.body

  if (!question || typeof question !== "string") {
    return fail(res, "请输入有效的搜索内容", 400)
  }

  const cleanQuestion = extractRawQuestion(question)
  if (!cleanQuestion) return success(res, [])

  const categoryHint = inferCategory(cleanQuestion)
  const categoryFilter = buildCategoryFilter(categoryHint)
  const personHint = extractPersonHint(cleanQuestion)
  const personIntent = isPersonIntent(cleanQuestion)

  try {
    const [local, tmdb] = await Promise.all([
      searchLocalCandidates(cleanQuestion, categoryHint),
      searchTmdbCandidates(cleanQuestion, categoryHint),
    ])
    let candidates = dedupeCandidates([...local, ...tmdb])
    if (candidates.length === 0 && personIntent && personHint) {
      const personRegex = new RegExp(escapeRegex(personHint), "i")
      const personQuery = {
        $or: [{ actors: personRegex }, { director: personRegex }, { title: personRegex }],
      }
      if (categoryFilter) personQuery.category = categoryFilter

      let personRows = await Video.find(personQuery)
        .sort({ rating: -1, vote_count: -1, updatedAt: -1 })
        .limit(16)
        .select("title year category rating")
        .lean()
      if (personRows.length === 0 && categoryFilter) {
        personRows = await Video.find({
          $or: [{ actors: personRegex }, { director: personRegex }, { title: personRegex }],
        })
          .sort({ rating: -1, vote_count: -1, updatedAt: -1 })
          .limit(16)
          .select("title year category rating")
          .lean()
      }
      candidates = dedupeCandidates(
        personRows.map((item, index) => ({
          id: `person_local_${index}`,
          title: item.title,
          year: item.year || "",
          category: item.category || "",
          rating: Number(item.rating || 0),
          source: "local",
        })),
      )
    }
    if (
      candidates.length === 0 &&
      (isRecommendationIntent(cleanQuestion) || personIntent)
    ) {
      let hotLocal = await Video.find(categoryFilter ? { category: categoryFilter } : {})
        .sort({ rating: -1, vote_count: -1, year: -1 })
        .limit(12)
        .select("title year category rating")
        .lean()
      if (hotLocal.length === 0 && categoryFilter) {
        hotLocal = await Video.find({})
          .sort({ rating: -1, vote_count: -1, year: -1 })
          .limit(12)
          .select("title year category rating")
          .lean()
      }
      candidates = dedupeCandidates(
        hotLocal.map((item, index) => ({
          id: `fallback_${index}`,
          title: item.title,
          year: item.year || "",
          category: item.category || "",
          rating: Number(item.rating || 0),
          source: "local",
        })),
      )
    }
    if (candidates.length === 0) return success(res, [])

    const reranked = await rerankByModel(cleanQuestion, candidates)
    const titles = reranked
      .map((item) => item.title)
      .filter(Boolean)
      .slice(0, 8)

    const sanitized = sanitizeTitleList(titles)
    if (sanitized.length > 0) {
      return success(res, sanitized)
    }

    const fallbackTitles = sanitizeTitleList(
      fallbackRank(candidates)
        .map((item) => item.title)
        .filter(Boolean),
    )
    if (fallbackTitles.length > 0) return success(res, fallbackTitles)

    const emergencyTitles = candidates
      .map((item) => normalizeTitle(item.title))
      .filter((item) => !looksLikeGarbage(item))
      .slice(0, 8)
    return success(res, emergencyTitles)
  } catch (error) {
    console.error("[Zhipu API Error]:", error.message || error)
    success(res, [])
  }
}
