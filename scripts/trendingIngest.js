const axios = require("axios")

const TMDB_BASE = "https://api.themoviedb.org/3"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const buildHeaders = () => {
  const token = String(process.env.TMDB_TOKEN || "").trim()
  if (!token) return {}
  return { Authorization: `Bearer ${token}` }
}

const fetchTmdbTitles = async (path, pages = 1, lang = "zh-CN") => {
  const out = []
  const headers = buildHeaders()
  for (let page = 1; page <= pages; page++) {
    const res = await axios.get(`${TMDB_BASE}${path}`, {
      params: { language: lang, page },
      timeout: 12000,
      headers,
      validateStatus: (s) => s >= 200 && s < 500,
    })
    const list = Array.isArray(res.data?.results) ? res.data.results : []
    for (const item of list) {
      const title = String(item?.name || item?.title || "").trim()
      if (title) out.push(title)
    }
  }
  return [...new Set(out)]
}

const ingestTitle = async (title) => {
  const base = String(process.env.INTERNAL_API_BASE || "http://127.0.0.1:3010/api").replace(/\/$/, "")
  const res = await axios.post(
    `${base}/v2/ingest`,
    { title },
    { timeout: 25000, validateStatus: (s) => s >= 200 && s < 500 },
  )
  return res.data || {}
}

async function runTrendingIngestJob(trigger = "cron") {
  const enabled = String(process.env.TRENDING_INGEST_ENABLED || "true") === "true"
  if (!enabled) {
    return { enabled: false, total: 0, ingested: 0, skipped: 0, failed: 0 }
  }

  const pages = Number.parseInt(String(process.env.TRENDING_INGEST_PAGES || "2"), 10)
  const limit = Number.parseInt(String(process.env.TRENDING_INGEST_LIMIT || "30"), 10)
  const intervalMs = Number.parseInt(String(process.env.TRENDING_INGEST_INTERVAL_MS || "600"), 10)

  const [popularTv, airingToday, trendingWeek] = await Promise.all([
    fetchTmdbTitles("/tv/popular", pages),
    fetchTmdbTitles("/tv/airing_today", 1),
    fetchTmdbTitles("/trending/tv/week", 1),
  ])

  const merged = [...new Set([...trendingWeek, ...airingToday, ...popularTv])].slice(0, limit)

  let ingested = 0
  let skipped = 0
  let failed = 0

  for (const title of merged) {
    try {
      const result = await ingestTitle(title)
      const ok = Number(result?.code || 500) === 200
      if (ok) ingested += 1
      else skipped += 1
    } catch (e) {
      failed += 1
    }
    await sleep(intervalMs)
  }

  return { trigger, total: merged.length, ingested, skipped, failed }
}

module.exports = { runTrendingIngestJob }
