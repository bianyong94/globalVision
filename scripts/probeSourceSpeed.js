const axios = require("axios")
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

const testUrl = async (url, timeout = 10000, proxy = "") => {
  const started = Date.now()
  try {
    const res = await axios.get(url, {
      timeout,
      responseType: "text",
      maxRedirects: 3,
      proxy: proxy ? false : undefined,
      httpAgent: undefined,
      httpsAgent: undefined,
      validateStatus: (s) => s >= 200 && s < 500,
      headers: {
        Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*",
        "User-Agent": "Mozilla/5.0",
      },
    })
    const ms = Date.now() - started
    return { ok: res.status < 400, ms, status: res.status }
  } catch (e) {
    return { ok: false, ms: Date.now() - started, status: 0 }
  }
}

const scoreBy = (avgMs, successRate) => {
  const speed =
    avgMs <= 400
      ? 100
      : avgMs >= 4000
        ? 0
        : Math.max(0, 100 - ((avgMs - 400) / 3600) * 100)
  // successRate 为 0-100 分值
  return Math.round(successRate * 0.7 + speed * 0.3)
}

async function runSourceProbe() {
  const sampleEach = Number.parseInt(String(process.env.SOURCE_PROBE_SAMPLE_EACH || "20"), 10)
  const timeout = Number.parseInt(String(process.env.SOURCE_PROBE_TIMEOUT_MS || "10000"), 10)
  const region = String(process.env.SOURCE_PROBE_REGION || "default")

  const rows = await Video.aggregate([
    { $unwind: "$sources" },
    {
      $project: {
        source_key: "$sources.source_key",
        vod_play_url: "$sources.vod_play_url",
      },
    },
    { $match: { source_key: { $exists: true, $ne: null } } },
    { $sample: { size: Math.max(80, sampleEach * 8) } },
  ])

  const grouped = new Map()
  for (const r of rows) {
    const key = String(r.source_key || "").trim()
    if (!key) continue
    const u = parseFirstPlayable(r.vod_play_url)
    if (!u || !/\.m3u8(\?.*)?$/i.test(u)) continue
    if (!grouped.has(key)) grouped.set(key, [])
    const arr = grouped.get(key)
    if (arr.length < sampleEach) arr.push(u)
  }

  const metrics = []
  for (const [source, urls] of grouped.entries()) {
    let ok = 0
    let totalMs = 0
    for (const u of urls) {
      const r = await testUrl(u, timeout)
      if (r.ok) ok += 1
      totalMs += r.ms
    }
    const total = urls.length || 1
    const successRate = (ok / total) * 100
    const avgMs = totalMs / total
    metrics.push({
      source,
      sample: total,
      successRate: Number(successRate.toFixed(2)),
      avgMs: Number(avgMs.toFixed(1)),
      score: scoreBy(avgMs, successRate),
      region,
      updatedAt: new Date(),
    })
  }

  metrics.sort((a, b) => b.score - a.score)

  const coll = Video.collection.conn.collection("source_speed_metrics")
  await coll.deleteMany({ region })
  if (metrics.length) {
    await coll.insertMany(metrics)
  }

  return { region, count: metrics.length, metrics }
}

module.exports = { runSourceProbe }
