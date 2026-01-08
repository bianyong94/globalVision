// utils/classifier.js

const countEpisodes = (urlStr) => {
  if (!urlStr) return 0
  return urlStr.split("#").length
}

const classifyVideo = (item) => {
  // 1. 数据清洗预处理
  const rawType = (item.type_name || item.original_type || "").trim()
  const rawName = (item.vod_name || item.title || "").trim().toUpperCase() // 转大写方便匹配 NBA/F1
  const remarks = (item.vod_remarks || item.remarks || "").trim().toUpperCase()
  const playUrl = item.vod_play_url || ""
  const area = (item.vod_area || item.area || "").trim()
  const yearStr = (item.vod_year || item.year || "").toString().trim()

  // 🛡️ 黑名单拦截
  if (
    /短剧|爽文|微剧|赘婿|战神|解说|写真/.test(rawType) ||
    /短剧|爽文/.test(rawName)
  ) {
    return null
  }

  let category = "movie"
  let tags = []

  // ==========================================
  // 🏷️ 1. 大类判定 (解决 动漫、综艺、体育 缺失)
  // ==========================================

  // 体育 (扩展关键词)
  if (
    /体育|赛事|足球|篮球|NBA|F1|英超|西甲|欧冠|CBA|奥运/.test(rawType) ||
    /NBA|F1|CBA/.test(rawName)
  ) {
    category = "sports"
  }
  // 动漫
  else if (/动(漫|画)/.test(rawType)) {
    category = "anime"
  }
  // 综艺
  else if (/综艺|晚会|秀/.test(rawType)) {
    category = "variety"
  }
  // 纪录片
  else if (/记录|纪录/.test(rawType)) {
    category = "doc"
  }
  // 剧集 vs 电影 (逻辑保持之前的强校验)
  else {
    const isExplicitMovie =
      /剧情片|电影|微电影/.test(rawType) ||
      (/片/.test(rawType) && !/剧/.test(rawType))
    const isExplicitTv = /剧/.test(rawType) && !/剧情片/.test(rawType)
    const isMultiEpisode = countEpisodes(playUrl) > 2

    if (isExplicitTv || isMultiEpisode) category = "tv"
    else if (isExplicitMovie) category = "movie"
    else category = "movie" // 兜底
  }

  // ==========================================
  // 🏷️ 2. 详细标签提取 (解决 缺悬疑/犯罪/战争/喜剧)
  // ==========================================

  // 针对原始分类的清洗
  let cleanType = rawType.replace(/电影|连续剧|片|剧|场/g, "")
  if (cleanType && cleanType.length > 1 && cleanType !== "国产")
    tags.push(cleanType)

  // 🔥 强力题材匹配 (只要标题或分类里有，就打标签)
  const genreMap = {
    悬疑: /悬疑|惊悚|迷案|探案/,
    犯罪: /犯罪|刑侦|警匪|黑帮/,
    科幻: /科幻|魔幻|异能/,
    喜剧: /喜剧|搞笑|爆笑/,
    爱情: /爱情|恋爱|甜宠|都市/,
    战争: /战争|军旅|抗日|谍战/,
    动作: /动作|武侠|功夫/,
    恐怖: /恐怖|惊悚|灵异/,
    古装: /古装|宫廷|穿越/,
    "4K": /4K|2160P/, // 解决 4K 缺失
    Netflix: /NETFLIX|奈飞|网飞/,
  }

  // 扫描分类和标题
  for (const [tag, regex] of Object.entries(genreMap)) {
    if (regex.test(rawType) || regex.test(rawName) || regex.test(remarks)) {
      tags.push(tag)
    }
  }

  // ==========================================
  // 🏷️ 3. 地区标签 (解决 缺韩剧/日漫/美剧)
  // ==========================================
  if (area) {
    if (area.includes("大陆") || area.includes("中国")) tags.push("国产")
    else if (area.includes("香港")) tags.push("港剧")
    else if (area.includes("台湾")) tags.push("台剧")
    else if (area.includes("美国") || area.includes("欧美"))
      tags.push("欧美") // 美剧/美影
    else if (area.includes("韩国")) tags.push("韩剧") // 解决韩剧少
    else if (area.includes("日本")) tags.push("日剧") // 解决日剧/日漫
  }

  // 修正标签逻辑
  if (category === "anime" && tags.includes("日剧")) {
    tags = tags.filter((t) => t !== "日剧")
    tags.push("日漫")
  }

  // ==========================================
  // 🏷️ 4. 特殊标签 (解决 4K/Netflix 首页展示)
  // ==========================================
  // 如果备注里有 4K/蓝光，强制加标签
  if (/4K|2160P/.test(remarks)) tags.push("4K")

  // 年份
  if (/^\d{4}$/.test(yearStr)) tags.push(yearStr)

  return {
    category,
    tags: [...new Set(tags)], // 去重
  }
}

module.exports = { classifyVideo }
