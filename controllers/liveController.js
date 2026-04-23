const axios = require("axios")
const { getAxiosConfig } = require("../utils/httpAgent")
const { getCache, setCache } = require("../utils/cache")

const LIVE_API_BASE = "https://zhiboapi3003.zb6.fun/webapi/live/getListByCategory"
const LIVE_PAGE_API_BASE = "https://zhiboapi3003.zb6.fun/webapi/live/getLivePageData"
const REAL_LIVES_API_BASE = "https://zhiboapi3003.zb6.fun/api/live/getRealLives"
const LIVE_SITE_ORIGIN = "https://kq8svip-iqy.92kq.cn"
const LIVE_SITE_REFERER = "https://kq8svip-iqy.92kq.cn/"
const LIVE_CACHE_TTL_SEC = 20
const LIVE_PAGE_CACHE_TTL_SEC = 15

const buildUserAgent = () =>
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

const isReplayHint = (text = "") =>
  /回放|录像|录播|重播|重播中|replay|vod/i.test(String(text || ""))

const inferLiveState = (item = {}) => {
  const status = Number(item.status || 0)
  const endStamp = item.end_stamp ? Number(item.end_stamp) : 0
  const startStamp = item.start_stamp ? Number(item.start_stamp) : 0
  const now = Math.floor(Date.now() / 1000)
  const titleText = [
    item.title,
    item.badge_text,
    item.anchor?.nick_name,
    item.anchor?.name,
  ]
    .filter(Boolean)
    .join(" ")

  if (endStamp > 0) return "ended"
  if (isReplayHint(titleText)) return "replay"
  if (status === 1) {
    if (startStamp > 0 && now - startStamp > 24 * 3600) return "unknown"
    return "live"
  }
  return "unknown"
}

const normalizeItem = (item = {}) => {
  const pullUrl = String(item.pull_url || item.stream || "").trim()
  const liveState = inferLiveState(item)
  const title = String(item.title || item.anchor?.nick_name || "未命名直播").trim()
  const badgeText = String(item.badge_text || "").trim()
  const anchorName = String(item.anchor?.nick_name || "").trim()
  const isLiveGuess = liveState === "live"

  return {
    id: String(item.liveid || item.id || item.anchorid || title),
    liveid: item.liveid || item.id || null,
    title,
    badge_text: badgeText,
    anchor_name: anchorName,
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
    is_live_guess: isLiveGuess,
    source_label: liveState === "live" ? "直播中" : liveState === "replay" ? "回放疑似" : "待确认",
  }
}

const fetchLiveListByCategory = async (params = {}) => {
  const response = await axios.post(LIVE_API_BASE, params, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": buildUserAgent(),
      Referer: LIVE_SITE_REFERER,
      Origin: LIVE_SITE_ORIGIN,
    },
    ...getAxiosConfig({ timeout: 10000 }),
  })

  if (response.status >= 400) {
    const err = new Error(`HTTP_${response.status}`)
    err.code = `HTTP_${response.status}`
    throw err
  }

  return response.data
}

const fetchUpstreamLiveJson = async (url, params = {}, referer = "https://zhiboapi3003.zb6.fun/") => {
  const response = await axios.post(url, params, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": buildUserAgent(),
      Referer: referer,
      Origin: LIVE_SITE_ORIGIN,
    },
    ...getAxiosConfig({ timeout: 10000 }),
  })

  if (response.status >= 400) {
    const err = new Error(`HTTP_${response.status}`)
    err.code = `HTTP_${response.status}`
    throw err
  }

  return response.data
}

exports.getBasketballLiveList = async (req, res) => {
  try {
    const categoryid = String(req.query.categoryid || "2")
    const page = String(req.query.page || "1")
    const platform = String(req.query.platform || "0")
    const size = String(req.query.size || "20")
    const sp_source = String(req.query.sp_source || "1102")

    const cacheKey = [
      "live:basketball",
      categoryid,
      page,
      platform,
      size,
      sp_source,
    ].join(":")

    const cached = await getCache(cacheKey)
    if (cached) {
      return res.json({ code: 200, data: cached, cached: true })
    }

    const upstream = await fetchLiveListByCategory({
      categoryid,
      page,
      platform,
      size,
      sp_source,
    })

    const sourceData = upstream?.data || upstream?.list || upstream?.result || []
    const list = Array.isArray(sourceData)
      ? sourceData
      : Array.isArray(sourceData?.list)
        ? sourceData.list
        : Array.isArray(sourceData?.data)
          ? sourceData.data
          : []

    const items = list
      .map(normalizeItem)
      .filter((item) => item.pull_url)
      .sort((a, b) => {
        const stateScore = (x) =>
          x.live_state === "live" ? 3000 : x.live_state === "replay" ? 2000 : 1000
        if (stateScore(b) !== stateScore(a)) return stateScore(b) - stateScore(a)
        if (b.hot !== a.hot) return b.hot - a.hot
        return Number(b.start_stamp || 0) - Number(a.start_stamp || 0)
      })

    const payload = {
      source: "zhiboapi3003.zb6.fun",
      categoryid: Number(categoryid),
      page: Number(page),
      platform: Number(platform),
      size: Number(size),
      sp_source,
      total: items.length,
      liveCount: items.filter((item) => item.live_state === "live").length,
      replayCount: items.filter((item) => item.live_state === "replay").length,
      items,
      raw: {
        code: upstream?.code ?? null,
        message: upstream?.message ?? null,
      },
    }

    await setCache(cacheKey, payload, LIVE_CACHE_TTL_SEC)
    return res.json({ code: 200, data: payload })
  } catch (error) {
    const detail = String(error?.code || error?.message || "UNKNOWN")
    return res.status(502).json({
      code: 502,
      message: "获取篮球直播列表失败",
      detail,
    })
  }
}

exports.getBasketballLivePageData = async (req, res) => {
  try {
    const anchorid = String(req.query.anchorid || "")
    if (!anchorid) {
      return res.status(400).json({ code: 400, message: "anchorid required" })
    }

    const params = {
      anchorid,
      check_sum:
        String(req.query.check_sum || "ef94edc2918f67a19ffe3447b7c65720").trim(),
      platform: String(req.query.platform || "0"),
      platform_check: String(req.query.platform_check || "0"),
      sp_source: String(req.query.sp_source || "1102"),
      userid: String(
        req.query.userid || `guest${Date.now()}${Math.floor(Math.random() * 1000)}`,
      ),
    }

    const cacheKey = [
      "live:page",
      params.anchorid,
      params.check_sum,
      params.platform,
      params.platform_check,
      params.sp_source,
      params.userid,
    ].join(":")

    const cached = await getCache(cacheKey)
    if (cached) {
      return res.json({ code: 200, data: cached, cached: true })
    }

    const upstream = await fetchUpstreamLiveJson(LIVE_PAGE_API_BASE, params, LIVE_SITE_REFERER)
    const data = upstream?.data || upstream || {}
    const live = data?.live || {}
    const pullUrl = String(live.pull_url || data.pull_url || "").trim()
    const item = normalizeItem({
      ...live,
      title: live.title || data.title,
      anchor: data.anchor || live.anchor,
      pull_url: pullUrl,
      thumb: live.thumb || data.thumb || "",
    })

    const payload = {
      source: "zhiboapi3003.zb6.fun",
      params,
      live: item,
      live_state: item.live_state,
      pull_url: pullUrl,
      streams: Array.isArray(live.pull_url_multiple_new)
        ? live.pull_url_multiple_new
        : [],
      raw: {
        code: upstream?.code ?? null,
        message: upstream?.message ?? null,
      },
    }

    await setCache(cacheKey, payload, LIVE_PAGE_CACHE_TTL_SEC)
    return res.json({ code: 200, data: payload })
  } catch (error) {
    const detail = String(error?.code || error?.message || "UNKNOWN")
    return res.status(502).json({
      code: 502,
      message: "获取直播详情失败",
      detail,
    })
  }
}

exports.getRealLives = async (req, res) => {
  try {
    const page = String(req.query.page || "1")
    const platform = String(req.query.platform || "0")
    const size = String(req.query.size || "12")
    const sp_source = String(req.query.sp_source || "1102")

    const cacheKey = ["live:real", page, platform, size, sp_source].join(":")
    const cached = await getCache(cacheKey)
    if (cached) {
      return res.json({ code: 200, data: cached, cached: true })
    }

    const upstream = await fetchUpstreamLiveJson(REAL_LIVES_API_BASE, {
      page,
      platform,
      size,
      sp_source,
    }, LIVE_SITE_REFERER)

    const sourceData = upstream?.list || upstream?.data || upstream?.result || []
    const list = Array.isArray(sourceData)
      ? sourceData
      : Array.isArray(sourceData?.list)
        ? sourceData.list
        : Array.isArray(sourceData?.data)
          ? sourceData.data
          : []

    const items = list
      .map(normalizeItem)
      .filter((item) => item.pull_url)
      .sort((a, b) => Number(b.hot || 0) - Number(a.hot || 0))

    const payload = {
      source: "zhiboapi3003.zb6.fun",
      page: Number(page),
      platform: Number(platform),
      size: Number(size),
      sp_source,
      total: items.length,
      liveCount: items.filter((item) => item.live_state === "live").length,
      replayCount: items.filter((item) => item.live_state === "replay").length,
      items,
      raw: {
        code: upstream?.code ?? null,
        message: upstream?.message ?? null,
      },
    }

    await setCache(cacheKey, payload, LIVE_CACHE_TTL_SEC)
    return res.json({ code: 200, data: payload })
  } catch (error) {
    const detail = String(error?.code || error?.message || "UNKNOWN")
    return res.status(502).json({
      code: 502,
      message: "获取实时直播列表失败",
      detail,
    })
  }
}
