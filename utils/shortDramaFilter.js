const axios = require("axios")
const { getAxiosConfig } = require("./httpAgent")

const STRONG_REGEX =
  /短剧|微短剧|miniseries|爽剧|爽文|赘婿|神豪|龙王|战神|闪婚|先婚后爱|重生|复仇|逆袭|99集|100集/i
const WEAK_REGEX =
  /娇妻|千金|总裁|首富|神医|仙尊|奶爸|王妃|王爷|离婚后|前妻|归来|下山|师姐|高手|天命|无双/i

const DEFAULT_HIGH_RISK_SOURCES = ["duanju", "kuaikan", "xingya", "suoni"]

const parseListEnv = (value = "") =>
  String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

const countEpisodes = (playUrl = "") => {
  const raw = String(playUrl || "").trim()
  if (!raw) return 0
  return raw
    .split("#")
    .map((x) => x.trim())
    .filter(Boolean).length
}

const getFirstPlayUrl = (vodPlayUrl = "") => {
  const first = String(vodPlayUrl || "").split("#")[0] || ""
  const part = first.split("$")
  const link = (part.length > 1 ? part[1] : part[0] || "").trim()
  return /^https?:\/\//i.test(link) ? link : ""
}

const isAreaLikelyCN = (item = {}) => {
  const text = `${item.vod_area || item.area || ""} ${item.type_name || ""}`
  return /中国|大陆|内地|国产/i.test(text)
}

const isWhitelisted = (item = {}) => {
  const title = String(item.vod_name || item.title || "").trim()
  const whiteTitles = parseListEnv(process.env.SHORT_DRAMA_WHITELIST_TITLES)
  if (whiteTitles.length > 0 && whiteTitles.some((x) => title.includes(x))) return true
  return false
}

const extractResolutionFromM3u8 = (text = "") => {
  const m = String(text).match(/RESOLUTION\s*=\s*(\d+)\s*x\s*(\d+)/i)
  if (!m) return null
  const w = Number.parseInt(m[1], 10)
  const h = Number.parseInt(m[2], 10)
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null
  return { width: w, height: h }
}

async function probeVerticalByM3u8(playUrl) {
  if (!playUrl || !/\.m3u8(\?|$)/i.test(playUrl)) return false
  try {
    const res = await axios.get(playUrl, {
      timeout: Number.parseInt(process.env.SHORT_DRAMA_PROBE_TIMEOUT_MS || "2500", 10),
      responseType: "text",
      transformResponse: [(x) => x],
      ...getAxiosConfig(),
    })
    const text = String(res.data || "").slice(0, 10000)
    const r = extractResolutionFromM3u8(text)
    return !!(r && r.height > r.width)
  } catch (_) {
    return false
  }
}

function scoreShortDrama(item = {}, sourceKey = "") {
  if (isWhitelisted(item)) {
    return { blocked: false, score: 0, reasons: ["whitelist"] }
  }

  const name = String(item.vod_name || item.title || "")
  const remarks = String(item.vod_remarks || item.remarks || "")
  const typeName = String(item.type_name || "")
  const combined = `${name} ${remarks} ${typeName}`
  const reasons = []
  let score = 0

  if (STRONG_REGEX.test(combined)) {
    reasons.push("strong-keyword")
    score += 6
  }
  if (WEAK_REGEX.test(combined)) {
    reasons.push("weak-keyword")
    score += 2
  }
  if (isAreaLikelyCN(item)) {
    reasons.push("cn-area")
    score += 1
  }

  const epCount = countEpisodes(item.vod_play_url || "")
  if (epCount >= 40) {
    reasons.push("many-episodes")
    score += 2
  }

  if (name.length >= 12 && /[，,:：!！?？]/.test(name)) {
    reasons.push("novel-style-title")
    score += 1
  }

  const year = Number.parseInt(String(item.vod_year || item.year || ""), 10)
  const nowYear = new Date().getFullYear()
  if (Number.isFinite(year) && year >= nowYear - 1 && !item.rating) {
    reasons.push("new-without-rating")
    score += 1
  }

  const highRisk = parseListEnv(process.env.SHORT_DRAMA_HIGH_RISK_SOURCES)
  const highRiskSources =
    highRisk.length > 0 ? highRisk : DEFAULT_HIGH_RISK_SOURCES
  if (highRiskSources.includes(String(sourceKey || "").toLowerCase())) {
    reasons.push("high-risk-source")
    score += 1
  }

  return { blocked: score >= 4, score, reasons }
}

async function shouldBlockShortDrama(item = {}, sourceKey = "") {
  const result = scoreShortDrama(item, sourceKey)
  if (result.blocked || result.score <= 2) return result

  const enableProbe = String(process.env.SHORT_DRAMA_VERTICAL_PROBE || "true") === "true"
  if (!enableProbe || result.score !== 3) return result

  const playUrl = getFirstPlayUrl(item.vod_play_url || "")
  if (!playUrl) return result

  const vertical = await probeVerticalByM3u8(playUrl)
  if (vertical) {
    return {
      blocked: true,
      score: 4,
      reasons: [...result.reasons, "vertical-video-probe"],
    }
  }
  return result
}

module.exports = {
  scoreShortDrama,
  shouldBlockShortDrama,
}
