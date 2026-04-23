const axios = require("axios")
const http = require("http")
const https = require("https")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const { getAxiosConfig } = require("../utils/httpAgent")

const MAX_URL_LENGTH = 4000
const HLS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CACHE_BYTES = 25 * 1024 * 1024
const PLAYLIST_CACHE_TTL_MS = 90 * 1000
const SEGMENT_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000
const LIVE_SITE_REFERER = "https://kq8svip-iqy.92kq.cn/classify/live?type=2"
const LIVE_SITE_ORIGIN = "https://kq8svip-iqy.92kq.cn"
const DEFAULT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, ETag, X-Video-Proxy, X-Video-Cache, X-Upstream-Host, X-Upstream-Status, X-Upstream-TimeMs",
  "Timing-Allow-Origin": "*",
}
const PREFETCH_TIMEOUT_MS = 8000
const noKeepAliveHttpAgent = new http.Agent({ keepAlive: false })
const noKeepAliveHttpsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: false,
})

const proxyStats = {
  since: Date.now(),
  playlist: {
    requests: 0,
    hit: 0,
    miss: 0,
    stale: 0,
    errors: 0,
    upstreamMsTotal: 0,
  },
  segment: {
    requests: 0,
    hit: 0,
    miss: 0,
    stale: 0,
    errors: 0,
    upstreamMsTotal: 0,
  },
}

const markStat = (type, key, upstreamMs = 0) => {
  const bucket = proxyStats[type]
  if (!bucket) return
  if (key === "requests") bucket.requests += 1
  else if (key === "hit") bucket.hit += 1
  else if (key === "miss") bucket.miss += 1
  else if (key === "stale") bucket.stale += 1
  else if (key === "errors") bucket.errors += 1
  if (Number.isFinite(upstreamMs) && upstreamMs > 0)
    bucket.upstreamMsTotal += upstreamMs
}

const summarizeBucket = (bucket) => {
  const req = bucket.requests || 0
  const missLike = (bucket.miss || 0) + (bucket.stale || 0)
  return {
    ...bucket,
    avgUpstreamMs:
      missLike > 0 ? Number((bucket.upstreamMsTotal / missLike).toFixed(1)) : 0,
    hitRate: req > 0 ? Number(((bucket.hit / req) * 100).toFixed(2)) : 0,
    errorRate: req > 0 ? Number(((bucket.errors / req) * 100).toFixed(2)) : 0,
  }
}

const fail = (res, msg = "Error", code = 500) =>
  res.status(code).json({ code, message: msg })
const failWithDetail = (res, msg = "Error", code = 500, detail = "") => {
  const payload = { code, message: msg }
  if (detail) payload.detail = String(detail)
  return res.status(code).json(payload)
}

const isPrivateHostname = (hostname) => {
  if (!hostname) return true
  const lower = hostname.toLowerCase()
  if (["localhost", "127.0.0.1", "::1"].includes(lower)) return true
  if (lower.endsWith(".local")) return true
  if (/^10\./.test(lower)) return true
  if (/^192\.168\./.test(lower)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(lower)) return true
  return false
}

const ensureDir = (dirPath) => {
  try {
    fs.mkdirSync(dirPath, { recursive: true })
  } catch (e) {}
}

const sha1 = (text) =>
  crypto.createHash("sha1").update(String(text)).digest("hex")

const extractUpstreamCandidates = (raw) => {
  const input = String(raw || "").trim()
  if (!input) return []
  const normalized = input.replace(/\r?\n/g, "#")
  const chunks = normalized
    .split("#")
    .map((s) => s.trim())
    .filter(Boolean)
  const out = []
  for (const chunk of chunks) {
    if (/^https?:\/\//i.test(chunk)) {
      out.push(chunk)
      continue
    }
    const m = chunk.match(/https?:\/\/[^\s]+/gi)
    if (m?.length) out.push(...m)
  }
  return Array.from(new Set(out))
}

const parseUpstreamUrl = (raw) => {
  const url = String(raw || "").trim()
  if (!url) return null
  if (url.length > MAX_URL_LENGTH) return null
  let parsed = null
  try {
    parsed = new URL(url)
  } catch (e) {
    return null
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null
  if (isPrivateHostname(parsed.hostname)) return null
  return parsed
}

const pickReachablePlaylist = async (req, headersBase, flags) => {
  const candidates = extractUpstreamCandidates(req.query.url)
  const parsed = candidates
    .map((c) => parseUpstreamUrl(c))
    .filter(Boolean)
  if (!parsed.length) return { upstreamUrl: null, upstream: null, lastError: null }

  let lastError = null
  const profiles = [
    { refererMode: flags.refererMode, noKeepAlive: false },
    { refererMode: "none", noKeepAlive: true },
    { refererMode: "origin", noKeepAlive: true },
  ]

  for (const upstreamUrl of parsed) {
    for (const profile of profiles) {
      try {
        const common = getAxiosConfig({ timeout: 10000 })
        const upstream = await fetchStreamWithRetry(
          upstreamUrl.toString(),
          {
            maxRedirects: 3,
            responseType: "text",
            validateStatus: (status) => status >= 200 && status < 500,
            headers: headersBase(upstreamUrl, profile),
            ...common,
            ...(profile.noKeepAlive
              ? {
                  httpAgent: noKeepAliveHttpAgent,
                  httpsAgent: noKeepAliveHttpsAgent,
                }
              : {}),
          },
          2,
        )
        if (upstream.status < 400) return { upstreamUrl, upstream, lastError: null }
        lastError = new Error(`HTTP_${upstream.status}`)
      } catch (e) {
        lastError = e
      }
    }
  }
  return { upstreamUrl: parsed[0], upstream: null, lastError }
}

const resolveUri = (baseUrl, uri) => {
  const u = String(uri || "").trim()
  if (!u) return ""
  try {
    return new URL(u, baseUrl).toString()
  } catch (e) {
    return ""
  }
}

const isM3u8 = (u) => /\.m3u8(\?.*)?$/i.test(String(u || ""))

const normalizeRefererMode = (input) => {
  const mode = String(input || "").trim().toLowerCase()
  if (["none", "omit", "no-referrer", "noreferrer"].includes(mode))
    return "none"
  if (["site", "page", "source"].includes(mode)) return "site"
  return "origin"
}

const parseProxyFlags = (req) => {
  const proxySegmentsRaw = String(
    req?.query?.proxy_segments ?? req?.query?.proxySegments ?? "",
  )
    .trim()
    .toLowerCase()
  const proxySegments = ["1", "true", "yes", "on"].includes(proxySegmentsRaw)
  const refererMode = normalizeRefererMode(req?.query?.referer ?? req?.query?.ref)
  const liveRaw = String(req?.query?.live ?? "")
    .trim()
    .toLowerCase()
  const live = ["1", "true", "yes", "on"].includes(liveRaw)
  return { proxySegments, refererMode, live }
}

const makeUpstreamHeaders = (upstreamUrl, refererMode = "origin", extra = {}) => ({
  ...extra,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  ...(refererMode === "none"
    ? {}
    : refererMode === "site"
      ? {
          Referer: LIVE_SITE_REFERER,
          Origin: LIVE_SITE_ORIGIN,
        }
      : { Referer: upstreamUrl.origin }),
})

const buildProxyPath = (type, upstream, flags = {}) => {
  const suffix = type === "playlist" ? "playlist.m3u8" : "segment"
  const params = new URLSearchParams()
  params.set("url", upstream)
  if (flags?.proxySegments) params.set("proxy_segments", "1")
  if (flags?.refererMode && flags.refererMode !== "origin") {
    params.set("ref", flags.refererMode)
  }
  if (flags?.live) params.set("live", "1")
  return `/api/video/proxy/${suffix}?${params.toString()}`
}

const guessContentType = (pathname = "") => {
  const p = String(pathname || "").toLowerCase()
  if (p.endsWith(".m3u8")) return "application/vnd.apple.mpegurl"
  if (p.endsWith(".ts")) return "video/mp2t"
  if (p.endsWith(".m4s")) return "video/iso.segment"
  if (p.endsWith(".mp4")) return "video/mp4"
  if (p.endsWith(".key")) return "application/octet-stream"
  if (p.endsWith(".vtt")) return "text/vtt"
  return "application/octet-stream"
}

const fetchStreamWithRetry = async (url, options = {}, retries = 1) => {
  let lastError = null
  const timeouts = [8000, 12000, 18000]
  for (let i = 0; i <= retries; i++) {
    try {
      const timeout = timeouts[Math.min(i, timeouts.length - 1)]
      const response = await axios.get(url, {
        ...options,
        ...getAxiosConfig({ timeout }),
      })
      if (response.status >= 500 && i < retries) continue
      return response
    } catch (error) {
      lastError = error
      if (i < retries) continue
    }
  }
  throw lastError || new Error("upstream fetch failed")
}

const setDefaultProxyHeaders = (res) => {
  for (const [key, value] of Object.entries(DEFAULT_HEADERS)) {
    res.setHeader(key, value)
  }
}

const serveCachedFile = (res, file, headers = {}) => {
  setDefaultProxyHeaders(res)
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) res.setHeader(key, value)
  }
  fs.createReadStream(file).pipe(res)
}

const prewarmSegmentCache = async (segmentUrl, refererMode = "origin") => {
  const upstreamUrl = parseUpstreamUrl(segmentUrl)
  if (!upstreamUrl) return
  const cacheDir = path.join(__dirname, "..", ".cache", "hls")
  ensureDir(cacheDir)
  const cacheKey = sha1(upstreamUrl.toString())
  const cacheFile = path.join(cacheDir, `${cacheKey}.bin`)
  try {
    const st = fs.statSync(cacheFile)
    if (Date.now() - st.mtimeMs < SEGMENT_CACHE_TTL_MS) return
  } catch (e) {}

  try {
    const response = await axios.get(upstreamUrl.toString(), {
      responseType: "stream",
      maxRedirects: 3,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: makeUpstreamHeaders(upstreamUrl, refererMode, {
        Accept: "*/*",
        "Accept-Encoding": "identity",
      }),
      ...getAxiosConfig({ timeout: PREFETCH_TIMEOUT_MS }),
    })

    const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`
    const writeStream = fs.createWriteStream(tmpFile)
    let aborted = false
    let seenBytes = 0

    response.data.on("data", (chunk) => {
      if (aborted) return
      seenBytes += chunk?.length || 0
      if (seenBytes > MAX_CACHE_BYTES) {
        aborted = true
        try {
          writeStream.destroy()
        } catch (e) {}
        try {
          fs.unlinkSync(tmpFile)
        } catch (e) {}
        try {
          response.data.destroy()
        } catch (e) {}
      }
    })

    response.data.pipe(writeStream)
    writeStream.on("finish", () => {
      if (aborted) return
      try {
        fs.renameSync(tmpFile, cacheFile)
      } catch (e) {
        try {
          fs.unlinkSync(tmpFile)
        } catch (e2) {}
      }
    })
    writeStream.on("error", () => {
      try {
        fs.unlinkSync(tmpFile)
      } catch (e) {}
    })
  } catch (e) {}
}

const rewriteTagUri = (line, baseUrl, flags = {}) => {
  const match = String(line).match(/URI="([^"]+)"/i)
  if (!match) return line
  const resolved = resolveUri(baseUrl, match[1])
  if (!resolved) return line
  const proxied = isM3u8(resolved)
    ? buildProxyPath("playlist", resolved, flags)
    : buildProxyPath("segment", resolved, flags)
  return line.replace(/URI="([^"]+)"/i, `URI="${proxied}"`)
}

exports.proxyPlaylist = async (req, res) => {
  markStat("playlist", "requests")
  const firstCandidate = extractUpstreamCandidates(req.query.url)[0] || req.query.url
  const upstreamUrl = parseUpstreamUrl(firstCandidate)
  if (!upstreamUrl) return fail(res, "无效播放地址", 400)
  const flags = parseProxyFlags(req)
  const shouldUseCache = !flags.live

  const ifNoneMatch = String(req.headers["if-none-match"] || "").trim()
  const cacheDir = path.join(__dirname, "..", ".cache", "hls-playlist")
  ensureDir(cacheDir)
  const cacheKey = sha1(upstreamUrl.toString())
  const cacheFile = path.join(cacheDir, `${cacheKey}.m3u8`)
  const etag = `"${cacheKey}"`

  if (shouldUseCache) {
    try {
      const st = fs.statSync(cacheFile)
      const fresh = Date.now() - st.mtimeMs < PLAYLIST_CACHE_TTL_MS
      if (fresh) {
        if (ifNoneMatch && ifNoneMatch === etag) {
          res.status(304)
          res.setHeader("ETag", etag)
          res.end()
          return
        }

        markStat("playlist", "hit")
        serveCachedFile(res, cacheFile, {
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
          "Cache-Control": "public, max-age=10, s-maxage=60, stale-if-error=120",
          "CDN-Cache-Control": "public, max-age=60",
          ETag: etag,
          "X-Video-Proxy": "globalVision",
          "X-Video-Cache": "hit",
          "X-Upstream-Host": upstreamUrl.hostname,
        })
        return
      }
    } catch (e) {}
  }

  try {
    const startedAt = Date.now()
    const picked = await pickReachablePlaylist(
      req,
      (u, profile) => ({
        Accept:
          "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*",
        "Accept-Encoding": "identity",
        Connection: profile?.noKeepAlive ? "close" : "keep-alive",
        ...makeUpstreamHeaders(
          u,
          profile?.refererMode || flags.refererMode || "origin",
        ),
      }),
      flags,
    )
    const activeUpstreamUrl = picked.upstreamUrl || upstreamUrl
    const upstream = picked.upstream

    if (!upstream) {
      const detail = String(
        picked.lastError?.code ||
          picked.lastError?.message ||
          `host=${activeUpstreamUrl.hostname}`,
      )
      return failWithDetail(res, "播放代理失败", 502, detail)
    }

    if (upstream.status >= 400) {
      const host = activeUpstreamUrl.hostname
      return failWithDetail(
        res,
        `播放源站请求失败(${upstream.status})`,
        502,
        `host=${host}`,
      )
    }

    const baseUrl = activeUpstreamUrl.toString()
    const raw = String(upstream.data || "")
    const lines = raw.split(/\r?\n/)
    let firstPlayableUrl = ""
    const rewritten = lines
      .map((line) => {
        const l = String(line || "")
        if (!l) return l

        // 关键点1：解密密钥 (Key) 通常受严格跨域限制且文件极小，保留走代理
        if (l.startsWith("#EXT-X-KEY") || l.startsWith("#EXT-X-MAP")) {
          return rewriteTagUri(l, baseUrl, flags)
        }

        if (l.startsWith("#")) return l
        const resolved = resolveUri(baseUrl, l)
        if (!resolved) return l
        if (!firstPlayableUrl) firstPlayableUrl = resolved

        // 关键点2：子 m3u8 继续代理，如果是 ts/m4s 分片，直接返回真实绝对地址直连源站！
        if (isM3u8(resolved)) return buildProxyPath("playlist", resolved, flags)
        const forceProxySegment =
          flags.proxySegments || activeUpstreamUrl.protocol === "http:"
        return forceProxySegment
          ? buildProxyPath("segment", resolved, flags)
          : resolved
      })
      .join("\n")

    const elapsedMs = Date.now() - startedAt
    markStat("playlist", "miss", elapsedMs)
    setDefaultProxyHeaders(res)
    res.setHeader(
      "Content-Type",
      "application/vnd.apple.mpegurl; charset=utf-8",
    )
    if (shouldUseCache) {
      res.setHeader(
        "Cache-Control",
        "public, max-age=10, s-maxage=60, stale-if-error=120",
      )
      res.setHeader("CDN-Cache-Control", "public, max-age=60")
    } else {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate")
      res.setHeader("Pragma", "no-cache")
      res.setHeader("Expires", "0")
      res.setHeader("CDN-Cache-Control", "no-store")
    }
    res.setHeader("X-Video-Proxy", "globalVision")
    res.setHeader("X-Video-Cache", "miss")
    res.setHeader("X-Upstream-Host", activeUpstreamUrl.hostname)
    res.setHeader("X-Upstream-Status", String(upstream.status))
    res.setHeader("X-Upstream-TimeMs", String(elapsedMs))
    res.setHeader("ETag", etag)
    res.end(rewritten)

    // if (firstPlayableUrl && !isM3u8(firstPlayableUrl)) {
    //   setImmediate(() => {
    //     prewarmSegmentCache(firstPlayableUrl)
    //   })
    // }

    if (shouldUseCache) {
      const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`
      try {
        fs.writeFileSync(tmpFile, rewritten, "utf-8")
        fs.renameSync(tmpFile, cacheFile)
      } catch (e) {
        try {
          fs.unlinkSync(tmpFile)
        } catch (e2) {}
      }
    }
  } catch (e) {
    if (shouldUseCache) {
      try {
        const st = fs.statSync(cacheFile)
        if (st?.size > 0) {
          if (ifNoneMatch && ifNoneMatch === etag) {
            res.status(304)
            res.setHeader("ETag", etag)
            res.end()
            return
          }
          markStat("playlist", "stale")
          serveCachedFile(res, cacheFile, {
            "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
            "Cache-Control":
              "public, max-age=10, s-maxage=60, stale-if-error=120",
            "CDN-Cache-Control": "public, max-age=60",
            ETag: etag,
            "X-Video-Proxy": "globalVision",
            "X-Video-Cache": "stale",
            "X-Upstream-Host": upstreamUrl.hostname,
          })
          return
        }
      } catch (e2) {}
    }
    markStat("playlist", "errors")
    const host = upstreamUrl.hostname
    const errCode = String(e?.code || "")
    const detail = `${errCode || "UNKNOWN"} ${e?.message || ""}`.trim()
    const likelyIpv6RouteIssue =
      host.includes(":") &&
      ["ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ENOTFOUND"].includes(
        errCode,
      )
    if (likelyIpv6RouteIssue) {
      return failWithDetail(
        res,
        "播放代理失败：服务器无法访问该IPv6源",
        502,
        detail,
      )
    }
    return failWithDetail(res, "播放代理失败", 502, detail)
  }
}

exports.getProxyStats = async (_req, res) => {
  const uptimeSec = Math.max(
    1,
    Math.floor((Date.now() - proxyStats.since) / 1000),
  )
  return res.json({
    code: 200,
    data: {
      since: new Date(proxyStats.since).toISOString(),
      uptimeSec,
      playlist: summarizeBucket(proxyStats.playlist),
      segment: summarizeBucket(proxyStats.segment),
    },
  })
}

exports.resetProxyStats = async (_req, res) => {
  proxyStats.since = Date.now()
  for (const k of ["playlist", "segment"]) {
    proxyStats[k] = {
      requests: 0,
      hit: 0,
      miss: 0,
      stale: 0,
      errors: 0,
      upstreamMsTotal: 0,
    }
  }
  return res.json({ code: 200, message: "ok" })
}

// exports.proxySegment = async (req, res) => {
//   markStat("segment", "requests")
//   const upstreamUrl = parseUpstreamUrl(req.query.url)
//   if (!upstreamUrl) return fail(res, "无效分片地址", 400)

//   const range = String(req.headers.range || "").trim()
//   const cacheDir = path.join(__dirname, "..", ".cache", "hls")
//   ensureDir(cacheDir)
//   const cacheKey = sha1(upstreamUrl.toString())
//   const cacheFile = path.join(cacheDir, `${cacheKey}.bin`)
//   const etag = `"${cacheKey}"`

//   const allowCache = !range

//   if (allowCache) {
//     try {
//       const st = fs.statSync(cacheFile)
//       const fresh = Date.now() - st.mtimeMs < SEGMENT_CACHE_TTL_MS
//       if (fresh) {
//         const ifNoneMatch = String(req.headers["if-none-match"] || "").trim()
//         if (ifNoneMatch && ifNoneMatch === etag) {
//           res.status(304)
//           res.setHeader("ETag", etag)
//           res.end()
//           return
//         }

//         markStat("segment", "hit")
//         serveCachedFile(res, cacheFile, {
//           "Content-Type": guessContentType(upstreamUrl.pathname),
//           "Cache-Control":
//             "public, max-age=86400, s-maxage=2592000, stale-if-error=86400",
//           "CDN-Cache-Control": "public, max-age=2592000",
//           ETag: etag,
//           "X-Video-Proxy": "globalVision",
//           "X-Video-Cache": "hit",
//           "Accept-Ranges": "bytes",
//         })
//         return
//       }
//     } catch (e) {}
//   }

//   try {
//     const startedAt = Date.now()
//     const upstream = await fetchStreamWithRetry(
//       upstreamUrl.toString(),
//       {
//         maxRedirects: 3,
//         responseType: "stream",
//         validateStatus: (status) => status >= 200 && status < 500,
//         headers: {
//           ...(range ? { Range: range } : {}),
//           Accept: "*/*",
//           "Accept-Encoding": "identity",
//           "User-Agent":
//             "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
//           Referer: upstreamUrl.origin,
//         },
//       },
//       1,
//     )

//     if (upstream.status >= 400) {
//       return fail(res, "分片源站请求失败", 502)
//     }

//     const contentType =
//       upstream.headers["content-type"] || "application/octet-stream"
//     const contentLen = Number(upstream.headers["content-length"] || 0)

//     const elapsedMs = Date.now() - startedAt
//     markStat("segment", "miss", elapsedMs)
//     res.status(upstream.status)
//     setDefaultProxyHeaders(res)
//     if (upstream.status === 206 && upstream.headers["content-range"]) {
//       res.setHeader("Content-Range", upstream.headers["content-range"])
//       res.setHeader("Accept-Ranges", "bytes")
//     } else {
//       res.setHeader("Accept-Ranges", "bytes")
//     }

//     res.setHeader("Content-Type", contentType)
//     if (contentLen) res.setHeader("Content-Length", String(contentLen))
//     res.setHeader(
//       "Cache-Control",
//       "public, max-age=86400, s-maxage=2592000, stale-if-error=86400",
//     )
//     res.setHeader("CDN-Cache-Control", "public, max-age=2592000")
//     res.setHeader("ETag", etag)
//     res.setHeader("X-Video-Proxy", "globalVision")
//     res.setHeader("X-Video-Cache", "miss")
//     res.setHeader("X-Upstream-Host", upstreamUrl.hostname)
//     res.setHeader("X-Upstream-Status", String(upstream.status))

//     const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`
//     const writeStream = fs.createWriteStream(tmpFile)
//     let cacheAborted = !allowCache
//     let seenBytes = 0

//     upstream.data.on("data", (chunk) => {
//       if (cacheAborted) return
//       seenBytes += chunk?.length || 0
//       if (seenBytes > MAX_CACHE_BYTES) {
//         cacheAborted = true
//         try {
//           writeStream.destroy()
//         } catch (e) {}
//         try {
//           fs.unlinkSync(tmpFile)
//         } catch (e) {}
//       }
//     })

//     upstream.data.pipe(writeStream)
//     upstream.data.pipe(res)

//     writeStream.on("finish", () => {
//       if (cacheAborted) return
//       try {
//         fs.renameSync(tmpFile, cacheFile)
//       } catch (e) {
//         try {
//           fs.unlinkSync(tmpFile)
//         } catch (e2) {}
//       }
//     })
//     writeStream.on("error", () => {
//       try {
//         fs.unlinkSync(tmpFile)
//       } catch (e) {}
//     })
//   } catch (e) {
//     if (allowCache) {
//       try {
//         const st = fs.statSync(cacheFile)
//         if (st?.size > 0) {
//           markStat("segment", "stale")
//           serveCachedFile(res, cacheFile, {
//             "Content-Type": guessContentType(upstreamUrl.pathname),
//             "Cache-Control":
//               "public, max-age=60, s-maxage=86400, stale-if-error=86400",
//             "CDN-Cache-Control": "public, max-age=86400",
//             ETag: etag,
//             "X-Video-Proxy": "globalVision",
//             "X-Video-Cache": "stale",
//             "Accept-Ranges": "bytes",
//           })
//           return
//         }
//       } catch (e2) {}
//     }
//     markStat("segment", "errors")
//     return fail(res, "分片代理失败", 502)
//   }
// }

exports.proxySegment = async (req, res) => {
  markStat("segment", "requests")
  const upstreamUrl = parseUpstreamUrl(req.query.url)
  if (!upstreamUrl) return fail(res, "无效分片地址", 400)
  const flags = parseProxyFlags(req)

  const range = String(req.headers.range || "").trim()

  try {
    const startedAt = Date.now()
    const upstream = await fetchStreamWithRetry(
      upstreamUrl.toString(),
      {
        maxRedirects: 3,
        responseType: "stream",
        validateStatus: (status) => status >= 200 && status < 500,
        headers: {
          ...(range ? { Range: range } : {}),
          ...makeUpstreamHeaders(upstreamUrl, flags.refererMode, {
            Accept: "*/*",
            "Accept-Encoding": "identity",
          }),
        },
      },
      1,
    )

    if (upstream.status >= 400) {
      const host = upstreamUrl.hostname
      return failWithDetail(
        res,
        `分片源站请求失败(${upstream.status})`,
        502,
        `host=${host}`,
      )
    }

    const elapsedMs = Date.now() - startedAt
    markStat("segment", "miss", elapsedMs)

    res.status(upstream.status)
    setDefaultProxyHeaders(res)

    if (upstream.status === 206 && upstream.headers["content-range"]) {
      res.setHeader("Content-Range", upstream.headers["content-range"])
      res.setHeader("Accept-Ranges", "bytes")
    } else {
      res.setHeader("Accept-Ranges", "bytes")
    }

    const contentType =
      upstream.headers["content-type"] || "application/octet-stream"
    const contentLen = Number(upstream.headers["content-length"] || 0)

    res.setHeader("Content-Type", contentType)
    if (contentLen) res.setHeader("Content-Length", String(contentLen))

    // 增加对 Cloudflare 的缓存指示，让 CDN 帮你扛流量
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=2592000")

    // 🔥 彻底抛弃 fs 读写，使用纯内存管道透传数据流给前端
    upstream.data.pipe(res)

    upstream.data.on("error", (err) => {
      console.error("分片流透传中断:", err.message)
      if (!res.headersSent) res.end()
    })
  } catch (e) {
    markStat("segment", "errors")
    const host = upstreamUrl.hostname
    const errCode = String(e?.code || "")
    const detail = `${errCode || "UNKNOWN"} ${e?.message || ""}`.trim()
    const likelyIpv6RouteIssue =
      host.includes(":") &&
      ["ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ENOTFOUND"].includes(
        errCode,
      )
    if (likelyIpv6RouteIssue) {
      return failWithDetail(
        res,
        "分片代理失败：服务器无法访问该IPv6源",
        502,
        detail,
      )
    }
    return failWithDetail(res, "分片代理失败", 502, detail)
  }
}
