const axios = require("axios")

const MAX_IMAGE_URL_LENGTH = 2000

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

exports.proxyImage = async (req, res) => {
  const url = String(req.query.url || "").trim()
  const quality = Number(req.query.q) || 75
  const width = Number(req.query.w) || 0

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

  try {
    const upstream = await axios.get(parsed.toString(), {
      responseType: "stream",
      timeout: 10000,
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
      return res.redirect(parsed.toString())
    }

    const contentType = upstream.headers["content-type"] || "image/jpeg"
    if (!String(contentType).startsWith("image/")) {
      return res.redirect(parsed.toString())
    }

    const cacheKey = `${parsed.toString()}|w=${width}|q=${quality}`
    res.setHeader("Content-Type", contentType)
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=2592000")
    res.setHeader("CDN-Cache-Control", "public, max-age=2592000")
    res.setHeader("Vary", "Accept")
    res.setHeader("X-Image-Proxy", "globalVision")
    res.setHeader("X-Image-Cache-Key", Buffer.from(cacheKey).toString("base64"))

    upstream.data.on("error", () => {
      if (!res.headersSent) {
        fail(res, "图片读取失败", 502)
      }
    })
    upstream.data.pipe(res)
  } catch (error) {
    console.error("[Image Proxy Error]", error.message || error)
    return res.redirect(parsed.toString())
  }
}
