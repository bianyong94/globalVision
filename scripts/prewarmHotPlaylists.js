const axios = require("axios")
const User = require("../models/User")
const Video = require("../models/Video")

const parseFirstPlayable = (vodPlayUrl = "") => {
  const block = String(vodPlayUrl || "").split("#").find(Boolean)
  if (!block) return ""
  const idx = block.indexOf("$")
  let u = idx >= 0 ? block.slice(idx + 1) : block
  if (u.includes("$$$")) {
    const parts = u.split("$$$").filter(Boolean)
    u = parts[parts.length - 1] || u
    if (u.includes("$")) u = u.slice(u.lastIndexOf("$") + 1)
  }
  u = String(u || "").trim()
  return /^https?:\/\//i.test(u) ? u : ""
}

const pickFromVideo = (video) => {
  const sources = Array.isArray(video?.sources) ? video.sources : []
  for (const s of sources) {
    const u = parseFirstPlayable(s?.vod_play_url)
    if (u && /\.m3u8(\?.*)?$/i.test(u)) return u
  }
  return ""
}

async function runPrewarmHotPlaylists() {
  const enabled = String(process.env.PLAY_PREWARM_ENABLED || "true") === "true"
  if (!enabled) return { enabled: false, warmed: 0 }

  const topUsers = Number.parseInt(String(process.env.PLAY_PREWARM_TOP_USERS || "120"), 10)
  const maxItems = Number.parseInt(String(process.env.PLAY_PREWARM_LIMIT || "80"), 10)
  const apiBase = String(process.env.INTERNAL_API_BASE || "http://127.0.0.1:3010/api").replace(/\/$/, "")

  const users = await User.find({}, { history: 1 }).sort({ createdAt: -1 }).limit(topUsers).lean()
  const score = new Map()
  for (const u of users) {
    const history = Array.isArray(u?.history) ? u.history.slice(0, 80) : []
    let weight = history.length
    for (const h of history) {
      const id = String(h?.id || "").trim()
      if (!id) continue
      score.set(id, (score.get(id) || 0) + Math.max(1, weight))
      weight = Math.max(1, weight - 1)
    }
  }

  const ids = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxItems)
    .map((x) => x[0])

  if (!ids.length) return { enabled: true, warmed: 0, reason: "no-history" }

  const objectIds = ids.filter((id) => /^[0-9a-fA-F]{24}$/.test(id))
  const videos = await Video.find({ $or: [{ uniq_id: { $in: ids } }, { _id: { $in: objectIds } }] })
    .select({ uniq_id: 1, sources: 1, updatedAt: 1 })
    .lean()

  let warmed = 0
  let failed = 0
  for (const v of videos) {
    const m3u8 = pickFromVideo(v)
    if (!m3u8) continue
    const proxyUrl = `${apiBase}/video/proxy/playlist.m3u8?url=${encodeURIComponent(m3u8)}`
    try {
      await axios.get(proxyUrl, { timeout: 12000, validateStatus: (s) => s >= 200 && s < 500 })
      warmed += 1
    } catch (e) {
      failed += 1
    }
  }

  return { enabled: true, warmed, failed, considered: videos.length }
}

module.exports = { runPrewarmHotPlaylists }
