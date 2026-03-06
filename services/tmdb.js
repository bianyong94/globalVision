const axios = require("axios")

const TMDB_BASE_URL = "https://api.themoviedb.org/3"
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500"

const TMDB_TOKEN = process.env.TMDB_TOKEN
const TMDB_API_KEY = process.env.TMDB_API_KEY

const api = axios.create({
  baseURL: TMDB_BASE_URL,
  timeout: 9000,
})

function normalizeTitle(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/第[0-9一二三四五六七八九十百]+[季部]/g, "")
    .replace(/s\d{1,2}/gi, "")
    .replace(/[\s:：·\-—_'"`~!@#$%^&*()（）[\]{}<>《》,，。.?？、\\/|]+/g, "")
    .trim()
}

function titleScore(a = "", b = "") {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.86
  let common = 0
  for (const ch of new Set(na.split(""))) {
    if (nb.includes(ch)) common += 1
  }
  return common / Math.max(na.length, nb.length)
}

function getAuthHeaders() {
  if (!TMDB_TOKEN) return {}
  return { Authorization: `Bearer ${TMDB_TOKEN}` }
}

function buildAuthParams() {
  if (!TMDB_API_KEY) return {}
  return { api_key: TMDB_API_KEY }
}

function guessMediaTypeByTypeId(typeId) {
  const n = Number(typeId)
  if (n === 1 || (n >= 6 && n <= 12)) return "movie"
  if (n === 2 || (n >= 13 && n <= 16) || n === 41) return "tv"
  if (n === 3 || n === 4 || (n >= 25 && n <= 33)) return "tv"
  return null
}

async function search(title, year, typeId) {
  if (!title) return null
  if (!TMDB_TOKEN && !TMDB_API_KEY) return null

  try {
    const mediaHint = guessMediaTypeByTypeId(typeId)
    const response = await api.get("/search/multi", {
      headers: getAuthHeaders(),
      params: {
        ...buildAuthParams(),
        language: "zh-CN",
        query: title,
        include_adult: false,
        page: 1,
      },
    })

    const list = Array.isArray(response.data?.results) ? response.data.results : []
    if (list.length === 0) return null

    let best = null
    let bestScore = -1

    for (const item of list) {
      const mt = item.media_type
      if (mt !== "movie" && mt !== "tv") continue
      if (mediaHint && mt !== mediaHint) continue

      const tmdbTitle = item.title || item.name || ""
      const score = titleScore(title, tmdbTitle)
      if (score < 0.4) continue

      if (year) {
        const d = item.release_date || item.first_air_date || ""
        const y = Number.parseInt(String(d).slice(0, 4), 10)
        if (Number.isFinite(y) && Math.abs(Number(year) - y) > 2) continue
      }

      if (score > bestScore) {
        best = item
        bestScore = score
      }
    }

    if (!best) return null

    return {
      id: best.id,
      media_type: best.media_type,
      title: best.title || best.name || title,
      original_title: best.original_title || best.original_name || "",
      release_date: best.release_date || "",
      first_air_date: best.first_air_date || "",
      overview: best.overview || "",
      poster_path: best.poster_path ? `${IMAGE_BASE_URL}${best.poster_path}` : "",
    }
  } catch (error) {
    console.error(`[TMDB] search failed: ${error.message}`)
    return null
  }
}

module.exports = {
  search,
}
