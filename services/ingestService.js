// services/ingestService.js
const tmdbApi = require("./tmdb") // 你的 TMDB 封装
const Video = require("../models/Video")
const { classifyVideo } = require("../utils/classifier")

const meta = classifyVideo(rawItem)

async function ingestVideo(cmsData, sourceKey) {
  // 1. 简单清洗 CMS 标题
  const cleanTitle = cmsData.vod_name
    .replace(/(国语|TC|HD|中字|蓝光|4K).*/g, "")
    .trim()
  const cmsYear = parseInt(cmsData.vod_year)

  // 2. 尝试从库里找是否已经存在该资源源 (更新逻辑)
  let video = await Video.findOne({
    "sources.source_key": sourceKey,
    "sources.source_id": cmsData.vod_id,
  })

  if (video) {
    // === 更新逻辑 ===
    // 既然已经匹配过，就只更新播放地址，绝对不改标题
    const sourceIdx = video.sources.findIndex(
      (s) => s.source_key === sourceKey && s.source_id === cmsData.vod_id
    )
    video.sources[sourceIdx].play_url = cmsData.vod_play_url
    video.sources[sourceIdx].remarks = cmsData.vod_remarks
    await video.save()
    console.log(`♻️ 更新资源: ${video.title} [${sourceKey}]`)
    return
  }

  // 3. 如果没存过，去 TMDB 找身份证 (新增逻辑)
  try {
    const tmdbResult = await tmdbApi.search(
      cleanTitle,
      cmsYear,
      cmsData.type_id
    ) // 需自行封装

    if (!tmdbResult) {
      console.warn(`🗑️ 无法匹配 TMDB，丢弃: ${cleanTitle}`)
      return
    }

    // 4. 再次查找数据库有没有这个 TMDB ID (防止重复创建)
    video = await Video.findOne({ tmdb_id: tmdbResult.id })

    const newSource = {
      source_key: sourceKey,
      source_id: cmsData.vod_id,
      source_name: cmsData.vod_name, // 保留原名备查
      remarks: cmsData.vod_remarks,
      play_url: cmsData.vod_play_url,
    }

    if (video) {
      // 库里有这电影(比如已有红牛源)，现在加上非凡源
      video.sources.push(newSource)
      await video.save()
      console.log(`➕ 追加源: ${video.title}`)
    } else {
      // 库里完全没有，新建 TMDB 标准档案
      await Video.create({
        tmdb_id: tmdbResult.id,
        category: tmdbResult.media_type, // 'movie' or 'tv'
        title: tmdbResult.title || tmdbResult.name,
        original_title: tmdbResult.original_title || tmdbResult.original_name,
        poster: tmdbResult.poster_path,
        year: parseInt(
          tmdbResult.release_date?.substring(0, 4) ||
            tmdbResult.first_air_date?.substring(0, 4)
        ),
        overview: tmdbResult.overview,
        sources: [newSource],
      })
      console.log(`✨ 新建档案: ${tmdbResult.title}`)
    }
  } catch (e) {
    console.error("入库失败", e)
  }
}
