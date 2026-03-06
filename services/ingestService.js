const tmdbApi = require("./tmdb")
const Video = require("../models/Video")
const { classifyVideo } = require("../utils/classifier")
const { shouldBlockShortDrama } = require("../utils/shortDramaFilter")
const { evaluateAdultContent } = require("../utils/adultContentFilter")

const normalizeTitle = (text = "") =>
  String(text)
    .toLowerCase()
    .replace(/第[0-9一二三四五六七八九十百]+[季部]/g, "")
    .replace(/s\d{1,2}/gi, "")
    .replace(/(国语|tc|hd|中字|蓝光|4k|1080p|2160p|未删减|完整版).*/gi, "")
    .replace(/[\s:：·\-—_'"`~!@#$%^&*()（）[\]{}<>《》,，。.?？、\\/|]+/g, "")
    .trim()

const titleLike = (a = "", b = "") => {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

const buildSourceDoc = (cmsData, sourceKey) => ({
  source_key: sourceKey,
  vod_id: String(cmsData.vod_id || ""),
  vod_name: cmsData.vod_name || "",
  vod_play_from: cmsData.vod_play_from || "",
  vod_play_url: cmsData.vod_play_url || "",
  remarks: cmsData.vod_remarks || "",
  updatedAt: new Date(),
})

const inferCategory = (cmsData) => {
  const meta = classifyVideo(cmsData || {})
  if (meta?.category) return meta.category
  const raw = String(cmsData?.type_name || "")
  if (/综艺|晚会/i.test(raw)) return "variety"
  if (/动漫|动画|番剧/i.test(raw)) return "anime"
  if (/剧|连续剧|电视剧/i.test(raw)) return "tv"
  return "movie"
}

async function ingestVideo(cmsData, sourceKey) {
  if (!cmsData || !cmsData.vod_id || !cmsData.vod_name) return null
  const adult = evaluateAdultContent(cmsData, sourceKey)
  if (adult.blocked) return null
  const shortDrama = await shouldBlockShortDrama(cmsData, sourceKey)
  if (shortDrama.blocked) {
    return null
  }
  const classified = classifyVideo(cmsData || {})
  if (!classified) return null

  const cleanTitle = String(cmsData.vod_name)
    .replace(/(国语|TC|HD|中字|蓝光|4K|1080P|2160P).*/gi, "")
    .trim()
  const cmsYear = parseInt(cmsData.vod_year, 10)

  // 1) 源级唯一命中：同源同vod_id直接更新
  let video = await Video.findOne({
    sources: {
      $elemMatch: {
        source_key: sourceKey,
        vod_id: String(cmsData.vod_id),
      },
    },
  })

  if (video) {
    const idx = video.sources.findIndex(
      (s) => s.source_key === sourceKey && String(s.vod_id) === String(cmsData.vod_id),
    )
    if (idx >= 0) {
      video.sources[idx].vod_name = cmsData.vod_name || video.sources[idx].vod_name
      video.sources[idx].vod_play_from =
        cmsData.vod_play_from || video.sources[idx].vod_play_from
      video.sources[idx].vod_play_url =
        cmsData.vod_play_url || video.sources[idx].vod_play_url
      video.sources[idx].remarks = cmsData.vod_remarks || video.sources[idx].remarks
      video.sources[idx].updatedAt = new Date()
      await video.save()
      return video
    }
  }

  // 2) TMDB 命中聚合
  let tmdbResult = null
  try {
    tmdbResult = await tmdbApi.search(cleanTitle, cmsYear, cmsData.type_id)
  } catch (_) {
    tmdbResult = null
  }

  const newSource = buildSourceDoc(cmsData, sourceKey)

  if (tmdbResult?.id) {
    video = await Video.findOne({ tmdb_id: tmdbResult.id })
    if (video) {
      const exists = video.sources.some(
        (s) => s.source_key === sourceKey && String(s.vod_id) === String(cmsData.vod_id),
      )
      if (!exists) {
        video.sources.push(newSource)
      }
      if (Number(tmdbResult.vote_average || 0) > 0) {
        video.rating = Number(tmdbResult.vote_average)
      }
      if (Number(tmdbResult.vote_count || 0) > 0) {
        video.vote_count = Number(tmdbResult.vote_count)
      }
      const releaseDate = tmdbResult.release_date || tmdbResult.first_air_date || ""
      if (releaseDate && !video.date) video.date = releaseDate
      const releaseYear = parseInt(String(releaseDate).slice(0, 4), 10)
      if (Number.isFinite(releaseYear) && !video.year) video.year = releaseYear
      if (tmdbResult.poster_path && !video.poster) video.poster = tmdbResult.poster_path
      if (tmdbResult.backdrop_path && !video.backdrop) video.backdrop = tmdbResult.backdrop_path
      await video.save()
      return video
    }

    return Video.create({
      tmdb_id: tmdbResult.id,
      category: tmdbResult.media_type === "movie" ? "movie" : "tv",
      title: tmdbResult.title || tmdbResult.name || cmsData.vod_name,
      original_title: tmdbResult.original_title || tmdbResult.original_name || "",
      poster: tmdbResult.poster_path || "",
      year: parseInt(
        (tmdbResult.release_date || tmdbResult.first_air_date || "").slice(0, 4),
        10,
      ) || cmsYear || undefined,
      date: tmdbResult.release_date || tmdbResult.first_air_date || "",
      overview: tmdbResult.overview || "",
      rating: Number(tmdbResult.vote_average || 0),
      vote_count: Number(tmdbResult.vote_count || 0),
      backdrop: tmdbResult.backdrop_path || "",
      tags: Array.isArray(classified.tags) ? classified.tags : [],
      sources: [newSource],
      is_enriched: false,
    })
  }

  // 3) TMDB 兜底失败：尽量合并到本地同标题条目，而不是直接丢弃
  video = await Video.findOne({ title: new RegExp(cleanTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })
  if (!video) {
    video = await Video.findOne({ year: cmsYear || undefined }).sort({ updatedAt: -1 })
    if (video && !titleLike(video.title, cmsData.vod_name)) {
      video = null
    }
  }

  if (video) {
    const exists = video.sources.some(
      (s) => s.source_key === sourceKey && String(s.vod_id) === String(cmsData.vod_id),
    )
    if (!exists) {
      video.sources.push(newSource)
      await video.save()
    }
    return video
  }

  return Video.create({
    category: classified.category || inferCategory(cmsData),
    title: cmsData.vod_name,
    original_title: "",
    poster: cmsData.vod_pic || "",
    year: Number.isFinite(cmsYear) ? cmsYear : undefined,
    overview: cmsData.vod_content || "",
    area: cmsData.vod_area || "",
    actors: cmsData.vod_actor || "",
    director: cmsData.vod_director || "",
    tags: Array.isArray(classified.tags) ? classified.tags : [],
    sources: [newSource],
    is_enriched: false,
  })
}

module.exports = {
  ingestVideo,
}
