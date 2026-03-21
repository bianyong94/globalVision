const axios = require("axios")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const { PassThrough } = require("stream")
const { getAxiosConfig } = require("../utils/httpAgent")

let sharp = null
try {
  sharp = require("sharp")
} catch (e) {
  sharp = null
}

const MAX_IMAGE_URL_LENGTH = 2000
const MAX_IMAGE_WIDTH = 2000
const MAX_IMAGE_TRANSFORM_BYTES = 25 * 1024 * 1024
const IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

const fetchImageWithRetry = async (url, axiosBaseConfig = {}) => {
  let lastError = null
  const timeouts = [4500, 3500]
  for (const timeout of timeouts) {
    try {
      const res = await axios.get(url, {
        ...axiosBaseConfig,
        ...getAxiosConfig({ timeout }),
      })
      return res
    } catch (err) {
      lastError = err
      const status = err?.response?.status
      if (status && status < 500 && status !== 429) break
    }
  }
  throw lastError || new Error('image upstream failed')
}

const fail = (res, msg = "Error", code = 500) =>
  res.status(code).json({ code, message: msg })

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

const computeCacheKey = (url, width, quality, format) => {
  const raw = `${url}|w=${width}|q=${quality}|f=${format}`
  return crypto.createHash("sha1").update(raw).digest("hex")
}

const getBestFormat = (acceptHeader = "") => {
  const accept = String(acceptHeader || "").toLowerCase()
  if (accept.includes("image/avif")) return "avif"
  if (accept.includes("image/webp")) return "webp"
  return "origin"
}

exports.proxyImage = async (req, res) => {
  const url = String(req.query.url || "").trim()
  const qualityRaw = Number(req.query.q)
  const widthRaw = Number(req.query.w)
  const quality = Number.isFinite(qualityRaw)
    ? Math.min(95, Math.max(30, qualityRaw))
    : 75
  const width = Number.isFinite(widthRaw)
    ? Math.min(MAX_IMAGE_WIDTH, Math.max(0, widthRaw))
    : 0

  if (!url) return fail(res, "缺少图片地址", 400)
  if (url.length > MAX_IMAGE_URL_LENGTH) return fail(res, "URL 过长", 400)

  let parsed = null
  try {
    parsed = new URL(url)
  } catch (error) {
    return fail(res, "无效 URL", 400)
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return fail(res, "仅支持 http/https 图片", 400)
  }

  if (isPrivateHostname(parsed.hostname)) {
    return fail(res, "目标地址不允许访问", 403)
  }

  let computedCacheFile = ""
  let computedServedType = "application/octet-stream"
  let computedEtag = ""

  try {
    const format = sharp ? getBestFormat(req.headers.accept) : "origin"
    const cacheDir = path.join(__dirname, "..", ".cache", "images")
    ensureDir(cacheDir)
    const cacheKey = computeCacheKey(parsed.toString(), width, quality, format)
    const cacheExt = format === "origin" ? "bin" : format
    const cacheFile = path.join(cacheDir, `${cacheKey}.${cacheExt}`)

    const ifNoneMatch = String(req.headers["if-none-match"] || "").trim()
    const etag = `"${cacheKey}"`
    const servedType =
      format === "avif"
        ? "image/avif"
        : format === "webp"
          ? "image/webp"
          : "application/octet-stream"

    computedCacheFile = cacheFile
    computedServedType = servedType
    computedEtag = etag

    try {
      const st = fs.statSync(cacheFile)
      const fresh = Date.now() - st.mtimeMs < IMAGE_CACHE_TTL_MS
      if (fresh) {
        if (ifNoneMatch && ifNoneMatch === etag) {
          res.status(304)
          res.setHeader("ETag", etag)
          res.end()
          return
        }

        res.setHeader("Content-Type", servedType)
        res.setHeader(
          "Cache-Control",
          "public, max-age=86400, s-maxage=2592000",
        )
        res.setHeader("CDN-Cache-Control", "public, max-age=2592000")
        res.setHeader("Vary", "Accept")
        res.setHeader("ETag", etag)
        res.setHeader("X-Image-Proxy", "globalVision")
        res.setHeader("X-Image-Cache", "hit")
        fs.createReadStream(cacheFile).pipe(res)
        return
      }
    } catch (e) {}

    const startedAt = Date.now()
    const upstream = await fetchImageWithRetry(parsed.toString(), {
      responseType: "stream",
      maxRedirects: 3,
      validateStatus: (status) => status >= 200 && status < 500,
      headers: {
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: parsed.origin,
      },
    })

    if (upstream.status >= 400) {
      return fail(res, "图片源站请求失败", 502)
    }

    const contentType = upstream.headers["content-type"] || "image/jpeg"
    if (!String(contentType).startsWith("image/")) {
      return res.redirect(parsed.toString())
    }

    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(304)
      res.setHeader("ETag", etag)
      res.end()
      upstream.data.destroy()
      return
    }

    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=2592000")
    res.setHeader("CDN-Cache-Control", "public, max-age=2592000")
    res.setHeader("Vary", "Accept")
    res.setHeader("ETag", etag)
    res.setHeader("X-Image-Proxy", "globalVision")
    res.setHeader("X-Upstream-Host", parsed.hostname)
    res.setHeader("X-Upstream-Status", String(upstream.status))
    res.setHeader("X-Upstream-TimeMs", String(Date.now() - startedAt))
    res.setHeader(
      "X-Image-Cache-Key",
      Buffer.from(
        `${parsed.toString()}|w=${width}|q=${quality}|f=${format}`,
      ).toString("base64"),
    )
    res.setHeader("X-Image-Cache", "miss")

    upstream.data.on("error", () => {
      if (!res.headersSent) {
        fail(res, "图片读取失败", 502)
      }
    })

    const shouldTransform =
      !!sharp &&
      (width > 0 || format !== "origin") &&
      !String(contentType).toLowerCase().includes("gif")

    if (!shouldTransform) {
      res.setHeader("Content-Type", contentType)
      const upstreamLen = Number(upstream.headers["content-length"] || 0)
      if (upstreamLen && upstreamLen > MAX_IMAGE_TRANSFORM_BYTES) {
        upstream.data.pipe(res)
        return
      }

      const tmpFile = `${cacheFile}.${process.pid}.${Date.now()}.tmp`
      const out = new PassThrough()
      const fileStream = fs.createWriteStream(tmpFile)
      let cacheAborted = false
      let seenBytes = 0

      out.on("data", (chunk) => {
        if (cacheAborted) return
        seenBytes += chunk?.length || 0
        if (seenBytes > MAX_IMAGE_TRANSFORM_BYTES) {
          cacheAborted = true
          try {
            fileStream.destroy()
          } catch (e) {}
          try {
            fs.unlinkSync(tmpFile)
          } catch (e) {}
        }
      })

      out.pipe(res)
      out.pipe(fileStream)
      upstream.data.pipe(out)

      fileStream.on("finish", () => {
        if (cacheAborted) return
        try {
          fs.renameSync(tmpFile, cacheFile)
        } catch (e) {
          try {
            fs.unlinkSync(tmpFile)
          } catch (e2) {}
        }
      })
      fileStream.on("error", () => {
        try {
          fs.unlinkSync(tmpFile)
        } catch (e) {}
      })
      return
    }

    const upstreamLen = Number(upstream.headers["content-length"] || 0)
    if (upstreamLen && upstreamLen > MAX_IMAGE_TRANSFORM_BYTES) {
      res.setHeader("Content-Type", contentType)
      upstream.data.pipe(res)
      return
    }

    const transformer = sharp({ failOn: "none" }).rotate()
    if (width > 0) transformer.resize({ width, withoutEnlargement: true })
    if (format === "avif") transformer.avif({ quality })
    else transformer.webp({ quality })

    res.setHeader(
      "Content-Type",
      format === "avif" ? "image/avif" : "image/webp",
    )

    const out = new PassThrough()
    const fileStream = fs.createWriteStream(cacheFile)
    out.pipe(res)
    out.pipe(fileStream)

    upstream.data.pipe(transformer).pipe(out)
    fileStream.on("error", () => {})
  } catch (error) {
    console.error("[Image Proxy Error]", error.message || error)
    try {
      const st = computedCacheFile ? fs.statSync(computedCacheFile) : null
      if (st?.size > 0) {
        const ifNoneMatch = String(req.headers["if-none-match"] || "").trim()
        if (computedEtag && ifNoneMatch && ifNoneMatch === computedEtag) {
          res.status(304)
          res.setHeader("ETag", computedEtag)
          res.end()
          return
        }

        res.setHeader("Content-Type", computedServedType)
        res.setHeader(
          "Cache-Control",
          "public, max-age=86400, s-maxage=2592000",
        )
        res.setHeader("CDN-Cache-Control", "public, max-age=2592000")
        res.setHeader("Vary", "Accept")
        res.setHeader("X-Image-Proxy", "globalVision")
        res.setHeader("X-Image-Cache", "stale")
        if (computedEtag) res.setHeader("ETag", computedEtag)
        fs.createReadStream(computedCacheFile).pipe(res)
        return
      }
    } catch (e) {}
    return res.redirect(parsed.toString())
  }
}
