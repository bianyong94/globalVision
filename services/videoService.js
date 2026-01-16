const axios = require("axios")
const Video = require("../models/Video")
const { classifyVideo } = require("../utils/classifier") // 确保此文件存在
const { getAxiosConfig } = require("../utils/httpAgent")
const { sources, PRIORITY_LIST } = require("../config/constants")

// 源健康状态管理
const sourceHealth = {}
PRIORITY_LIST.forEach((key) => {
  sourceHealth[key] = { failCount: 0, deadUntil: 0 }
})

const markSourceFailed = (key) => {
  const health = sourceHealth[key]
  health.failCount++
  if (health.failCount >= 3) {
    health.deadUntil = Date.now() + 5 * 60 * 1000
    console.warn(`🔥 [熔断] 源 ${key} 暂停使用 5分钟`)
  }
}

const markSourceSuccess = (key) => {
  if (sourceHealth[key].failCount > 0) {
    sourceHealth[key].failCount = 0
    sourceHealth[key].deadUntil = 0
  }
}

// 智能请求函数
const smartFetch = async (paramsFn, options = null) => {
  let targetKeys = []
  const specificSourceKey = typeof options === "string" ? options : options?.key

  if (specificSourceKey) {
    targetKeys = [specificSourceKey]
  } else {
    targetKeys = PRIORITY_LIST.filter(
      (key) => sourceHealth[key].deadUntil <= Date.now()
    ).slice(0, 3)
  }

  if (targetKeys.length === 0) targetKeys = [PRIORITY_LIST[0]]

  const requests = targetKeys.map(async (key) => {
    const source = sources[key]
    try {
      const params = paramsFn(source)
      const startTime = Date.now()
      const response = await axios.get(source.url, {
        params,
        ...getAxiosConfig(),
        timeout: 3000,
      })

      if (response.data?.list?.length > 0) {
        markSourceSuccess(key)
        return {
          data: response.data,
          sourceName: source.name,
          sourceKey: key,
          duration: Date.now() - startTime,
        }
      }
      throw new Error("Empty Data")
    } catch (err) {
      if (!specificSourceKey) markSourceFailed(key)
      throw err
    }
  })

  try {
    return await Promise.any(requests)
  } catch (err) {
    throw new Error("所有线路繁忙或无数据")
  }
}

// 数据入库标准化
const saveToDB = async (item, sourceKey) => {
  try {
    const classified = classifyVideo(item)
    if (!classified) return null

    let safeYear = parseInt(item.vod_year)
    if (isNaN(safeYear) || safeYear < 1900 || safeYear > 2030) {
      safeYear = item.vod_time ? parseInt(item.vod_time.substring(0, 4)) : 0
    }

    const typeId = parseInt(item.type_id) || 0
    let category = "other"
    // ... 这里保留原有的 category 判断逻辑 ...
    if (typeId === 1 || (typeId >= 6 && typeId <= 12)) category = "movie"
    else if (typeId === 2 || (typeId >= 13 && typeId <= 24)) category = "tv"
    else if (typeId === 3 || (typeId >= 25 && typeId <= 29))
      category = "variety"
    else if (typeId === 4 || (typeId >= 30 && typeId <= 39)) category = "anime"

    let tags = classified.tags || []
    const title = item.vod_name || ""
    const typeName = item.type_name || ""
    if (title.includes("4K") || title.includes("2160P")) tags.push("4K")
    if (typeName.includes("短剧") || title.includes("短剧"))
      tags.push("miniseries")

    const videoData = {
      id: `${sourceKey}$${item.vod_id}`,
      uniq_id: `${sourceKey}_${item.vod_id}`,
      source: sourceKey,
      vod_id: item.vod_id,
      title: title.trim(),
      type_id: typeId,
      type: typeName,
      category: classified.category || category, // 优先用分类器的
      tags: tags,
      poster: item.vod_pic,
      remarks: item.vod_remarks,
      year: safeYear,
      date: item.vod_time,
      rating: parseFloat(item.vod_score) || 0,
      actors: item.vod_actor || "",
      director: item.vod_director || "",
      overview: (item.vod_content || "")
        .replace(/<[^>]+>/g, "")
        .substring(0, 200),
      vod_play_from: item.vod_play_from,
      vod_play_url: item.vod_play_url,
      updatedAt: new Date(),
    }

    await Video.updateOne(
      { uniq_id: videoData.uniq_id },
      { $set: videoData, $setOnInsert: { tmdb_id: undefined } },
      { upsert: true }
    )

    return videoData
  } catch (e) {
    console.error("SaveToDB Error:", e.message)
    return null
  }
}

module.exports = { smartFetch, saveToDB, getAxiosConfig }
