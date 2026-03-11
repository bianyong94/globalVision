const Video = require("../models/Video")
const { evaluateAdultContent } = require("../utils/adultContentFilter")
const { shouldBlockShortDrama } = require("../utils/shortDramaFilter")

const escapeRegex = (string) => {
  return String(string || "").replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
}

const toYear = (value) => {
  const n = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const toCategory = (typeName = "") => {
  const t = String(typeName || "")
  if (t.includes("剧")) return "tv"
  if (t.includes("综艺") || t.includes("晚会")) return "variety"
  if (t.includes("动漫") || t.includes("动画")) return "anime"
  if (t.includes("体育") || t.includes("赛事")) return "sports"
  return "movie"
}

const buildSourcePayload = (item, sourceKey) => {
  return {
    source_key: sourceKey,
    vod_id: String(item?.vod_id || ""),
    vod_name: String(item?.vod_name || ""),
    vod_play_from: item?.vod_play_from,
    vod_play_url: String(item?.vod_play_url || ""),
    remarks: item?.vod_remarks,
    updatedAt: new Date(),
  }
}

exports.ingestVideo = async (item, sourceKey) => {
  if (!item) throw new Error("missing item")
  const sk = String(sourceKey || "").trim()
  if (!sk) throw new Error("missing sourceKey")
  const vodId = String(item?.vod_id || "").trim()
  const vodName = String(item?.vod_name || "").trim()
  const vodPlayUrl = String(item?.vod_play_url || "").trim()
  if (!vodId || !vodName || !vodPlayUrl) return null

  const adult = evaluateAdultContent(item, sk)
  if (adult?.blocked) return null
  const judge = await shouldBlockShortDrama(item, sk)
  if (judge?.blocked) return null

  const existBySource = await Video.findOne({
    sources: { $elemMatch: { source_key: sk, vod_id: vodId } },
  })
  if (existBySource) {
    let modified = false
    const now = new Date()
    for (const src of existBySource.sources || []) {
      if (src?.source_key !== sk) continue
      if (String(src?.vod_id || "") !== vodId) continue

      const next = buildSourcePayload(item, sk)
      if (src.vod_name !== next.vod_name) {
        src.vod_name = next.vod_name
        modified = true
      }
      if (src.vod_play_from !== next.vod_play_from) {
        src.vod_play_from = next.vod_play_from
        modified = true
      }
      if (src.vod_play_url !== next.vod_play_url) {
        src.vod_play_url = next.vod_play_url
        modified = true
      }
      if (src.remarks !== next.remarks) {
        src.remarks = next.remarks
        modified = true
      }
      src.updatedAt = now
    }

    if (modified) {
      if (item?.vod_remarks) existBySource.latest_remarks = item.vod_remarks
      await existBySource.save()
      return existBySource
    }
    return null
  }

  const safeTitle = escapeRegex(vodName)
  const existByTitle = await Video.findOne({
    title: { $regex: new RegExp(`^${safeTitle}$`, "i") },
  })

  if (existByTitle) {
    const now = new Date()
    const existing = (existByTitle.sources || []).find((s) => s?.source_key === sk)

    if (existing) {
      const next = buildSourcePayload(item, sk)
      let modified = false
      if (String(existing.vod_id || "") !== vodId) {
        existing.vod_id = vodId
        modified = true
      }
      if (existing.vod_name !== next.vod_name) {
        existing.vod_name = next.vod_name
        modified = true
      }
      if (existing.vod_play_from !== next.vod_play_from) {
        existing.vod_play_from = next.vod_play_from
        modified = true
      }
      if (existing.vod_play_url !== next.vod_play_url) {
        existing.vod_play_url = next.vod_play_url
        modified = true
      }
      if (existing.remarks !== next.remarks) {
        existing.remarks = next.remarks
        modified = true
      }
      existing.updatedAt = now

      if (modified) {
        if (item?.vod_remarks) existByTitle.latest_remarks = item.vod_remarks
        await existByTitle.save()
        return existByTitle
      }
      return null
    }

    existByTitle.sources.push(buildSourcePayload(item, sk))
    existByTitle.updatedAt = now
    if (item?.vod_remarks) existByTitle.latest_remarks = item.vod_remarks
    await existByTitle.save()
    return existByTitle
  }

  const newVideo = new Video({
    title: vodName,
    original_title: item?.vod_en,
    category: toCategory(item?.type_name),
    year: toYear(item?.vod_year),
    date: item?.vod_pubdate,
    actors: item?.vod_actor,
    director: item?.vod_director,
    area: item?.vod_area,
    language: item?.vod_lang,
    duration: item?.vod_duration,
    overview: item?.vod_content,
    poster: item?.vod_pic,
    backdrop: item?.vod_pic_slide,
    sources: [buildSourcePayload(item, sk)],
    latest_remarks: item?.vod_remarks,
  })

  await newVideo.save()
  return newVideo
}
