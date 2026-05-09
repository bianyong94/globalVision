const axios = require("axios")
const { getAxiosConfig } = require("../utils/httpAgent")
const { getCache, setCache } = require("../utils/cache")

const LIVE_API_HOSTS = [
  "https://zhiboapi1001.bszb.me",
  "https://zhiboapi3003.zb6.fun",
]
const LIVE_SITE_ORIGIN = "https://svipkanqiu8-qq.92kq.cn"
const LIVE_SITE_REFERER = "https://svipkanqiu8-qq.92kq.cn/classify/live?type=2"
const LIVE_CACHE_TTL_SEC = 15

const buildUserAgent = () =>
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const isReplayHint = (text = "") =>
  /回放|录像|录播|重播|replay|vod|playlist_eof/i.test(String(text || ""))

const inferLiveState = (item = {}) => {
  const status = Number(item.status || 0)
  const endStamp = item.end_stamp ? Number(item.end_stamp) : 0
  const startStamp = item.start_stamp ? Number(item.start_stamp) : 0
  const now = Math.floor(Date.now() / 1000)
  const merged = [item.title, item.badge_text, item.anchor?.nick_name]
    .filter(Boolean)
    .join(" ")

  if (endStamp > 0) return "ended"
  if (isReplayHint(merged)) return "replay"
  if (status === 1) {
    if (startStamp > 0 && now - startStamp > 36 * 3600) return "unknown"
    return "live"
  }
  return "unknown"
}

const normalizeItem = (item = {}) => {
  const pullUrl = String(item.pull_url || item.stream || "").trim()
  const liveState = inferLiveState(item)
  return {
    id: String(item.liveid || item.id || item.anchorid || item.title || Date.now()),
    liveid: item.liveid || item.id || null,
    title: String(item.title || item.anchor?.nick_name || "未命名直播"),
    badge_text: String(item.badge_text || ""),
    anchor_name: String(item.anchor?.nick_name || ""),
    anchorid: item.anchorid || null,
    thumb: item.thumb || item.mask_thumb || "",
    pull_url: pullUrl,
    hot: Number(item.hot || 0),
    start_time: item.start_time || "",
    start_stamp: item.start_stamp || null,
    end_time: item.end_time || null,
    end_stamp: item.end_stamp || null,
    status: item.status || 0,
    room_type: item.room_type || 0,
    enable_web: item.enable_web ?? 0,
    enable_h5: item.enable_h5 ?? 0,
    enable_ios: item.enable_ios ?? 0,
    enable_android: item.enable_android ?? 0,
    categoryid: item.categoryid || null,
    sp_ids: item.sp_ids || "",
    sp_source: item.sp_source || "",
    live_state: liveState,
    is_live_guess: liveState === "live",
    source_label:
      liveState === "live"
        ? "直播中"
        : liveState === "replay"
          ? "回放疑似"
          : "待确认",
  }
}

const normalizeCategory = (raw = {}) => ({
  id: Number(raw.id || 0),
  title: String(raw.title || ""),
  icon: String(raw.icon || ""),
  sort: Number(raw.sort || 0),
  status: Number(raw.status || 0),
})

const getLiveHeaders = () => ({
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "User-Agent": buildUserAgent(),
  Referer: LIVE_SITE_REFERER,
  Origin: LIVE_SITE_ORIGIN,
})

const postLiveWithFallback = async (pathname, payload = {}, timeout = 10000) => {
  let lastError = null
  for (const host of LIVE_API_HOSTS) {
    try {
      const response = await axios.post(`${host}${pathname}`, payload, {
        headers: getLiveHeaders(),
        ...getAxiosConfig({ timeout }),
      })
      if (response.status >= 400) throw new Error(`HTTP_${response.status}`)
      const data = response.data || {}
      if (Number(data.status) !== 0 && data.status !== undefined) {
        const msg = data?.message || data?.msg || `APP_STATUS_${data.status}`
        const err = new Error(msg)
        err.code = `APP_STATUS_${data.status}`
        throw err
      }
      return { host, data }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error("UPSTREAM_FAILED")
}

const selectListFromPayload = (upstreamData) => {
  const data = upstreamData?.data
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.list)) return data.list
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(upstreamData?.list)) return upstreamData.list
  return []
}

exports.getLiveCategories = async (req, res) => {
  try {
    const cacheKey = "live:categories:v2"
    const cached = await getCache(cacheKey)
    if (cached) return res.json({ code: 200, data: cached, cached: true })

    const { host, data } = await postLiveWithFallback("/webapi/live/getCategory", {})
    const categories = selectListFromPayload(data)
      .map(normalizeCategory)
      .filter((x) => x.id > 0 && x.status === 1)
      .sort((a, b) => a.sort - b.sort)

    const payload = { source: host, total: categories.length, items: categories }
    await setCache(cacheKey, payload, LIVE_CACHE_TTL_SEC)
    return res.json({ code: 200, data: payload })
  } catch (error) {
    return res.status(502).json({
      code: 502,
      message: "获取直播分类失败",
      detail: String(error?.code || error?.message || "UNKNOWN"),
    })
  }
}

exports.getLiveListByCategory = async (req, res) => {
  try {
    const categoryid = Number(req.query.categoryid || 2)
    const page = Number(req.query.page || 1)
    const size = Number(req.query.size || 20)
    const platform = Number(req.query.platform || 0)
    const sp_source = String(req.query.sp_source || "1102")
    const params = { categoryid, page, size, platform, sp_source }
    const cacheKey = `live:list:${categoryid}:${page}:${size}:${platform}:${sp_source}`
    const cached = await getCache(cacheKey)
    if (cached) return res.json({ code: 200, data: cached, cached: true })

    const { host, data } = await postLiveWithFallback(
      "/webapi/live/getListByCategory",
      params,
    )
    const list = selectListFromPayload(data)
    const count = Number(data?.data?.count || list.length || 0)
    const filterCount = Number(data?.data?.filter_count || 0)

    const items = list
      .map(normalizeItem)
      .filter((x) => x.pull_url)
      .sort((a, b) => {
        const lv = (x) =>
          x.live_state === "live" ? 3000 : x.live_state === "replay" ? 2000 : 1000
        if (lv(a) !== lv(b)) return lv(b) - lv(a)
        if (a.hot !== b.hot) return b.hot - a.hot
        return Number(b.start_stamp || 0) - Number(a.start_stamp || 0)
      })

    const payload = {
      source: host,
      categoryid,
      page,
      size,
      platform,
      sp_source,
      total: items.length,
      count,
      filter_count: filterCount,
      liveCount: items.filter((x) => x.live_state === "live").length,
      replayCount: items.filter((x) => x.live_state === "replay").length,
      items,
    }
    await setCache(cacheKey, payload, LIVE_CACHE_TTL_SEC)
    return res.json({ code: 200, data: payload })
  } catch (error) {
    return res.status(502).json({
      code: 502,
      message: "获取分类直播列表失败",
      detail: String(error?.code || error?.message || "UNKNOWN"),
    })
  }
}

exports.getLivePageData = async (req, res) => {
  try {
    const anchorid = String(req.query.anchorid || "").trim()
    if (!anchorid) return res.status(400).json({ code: 400, message: "anchorid required" })

    const params = {
      anchorid: Number(anchorid),
      platform_check: Number(req.query.platform_check || 0),
      platform: Number(req.query.platform || 0),
      sp_source: String(req.query.sp_source || "1102"),
      check_sum: String(req.query.check_sum || "").trim() || undefined,
      userid:
        String(req.query.userid || "").trim() ||
        `guest${Date.now()}${Math.floor(Math.random() * 1000)}`,
    }
    if (!params.check_sum) delete params.check_sum
    const cacheKey = `live:page:${params.anchorid}:${params.platform}:${params.platform_check}:${params.sp_source}`
    const cached = await getCache(cacheKey)
    if (cached) return res.json({ code: 200, data: cached, cached: true })

    const { host, data } = await postLiveWithFallback(
      "/webapi/live/getLivePageData",
      params,
    )
    const liveRaw = data?.data?.live || {}
    const live = normalizeItem({
      ...liveRaw,
      anchor: data?.data?.anchor || liveRaw?.anchor,
    })

    const payload = {
      source: host,
      params,
      live,
      pull_url: live.pull_url,
      streams: Array.isArray(liveRaw?.pull_url_multiple_new)
        ? liveRaw.pull_url_multiple_new
        : [],
      room: data?.data || {},
    }
    await setCache(cacheKey, payload, 10)
    return res.json({ code: 200, data: payload })
  } catch (error) {
    return res.status(502).json({
      code: 502,
      message: "获取直播详情失败",
      detail: String(error?.code || error?.message || "UNKNOWN"),
    })
  }
}

exports.getRealLives = async (req, res) => {
  try {
    const page = Number(req.query.page || 1)
    const size = Number(req.query.size || 12)
    const platform = Number(req.query.platform || 0)
    const sp_source = String(req.query.sp_source || "1102")
    const params = { page, size, platform, sp_source }
    const cacheKey = `live:real:${page}:${size}:${platform}:${sp_source}`
    const cached = await getCache(cacheKey)
    if (cached) return res.json({ code: 200, data: cached, cached: true })

    const { host, data } = await postLiveWithFallback("/api/live/getRealLives", params)
    const list = selectListFromPayload(data)
    const count = Number(data?.data?.count || list.length || 0)

    const items = list
      .map(normalizeItem)
      .filter((x) => x.pull_url)
      .sort((a, b) => Number(b.hot || 0) - Number(a.hot || 0))

    const payload = {
      source: host,
      categoryid: 0,
      page,
      size,
      platform,
      sp_source,
      total: items.length,
      count,
      liveCount: items.filter((x) => x.live_state === "live").length,
      replayCount: items.filter((x) => x.live_state === "replay").length,
      items,
    }
    await setCache(cacheKey, payload, LIVE_CACHE_TTL_SEC)
    return res.json({ code: 200, data: payload })
  } catch (error) {
    return res.status(502).json({
      code: 502,
      message: "获取实时直播列表失败",
      detail: String(error?.code || error?.message || "UNKNOWN"),
    })
  }
}

exports.getBasketballLiveList = exports.getLiveListByCategory
exports.getBasketballLivePageData = exports.getLivePageData
