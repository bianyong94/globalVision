// utils/classifier.js

/**
 * 辅助：计算集数 (通过播放链接数量判断)
 */
const countEpisodes = (urlStr) => {
  if (!urlStr) return 0
  // 兼容两种常见格式: "第1集$url#第2集$url" 或 "url1#url2"
  return urlStr.split("#").length
}

/**
 * 核心分类函数
 * @param {Object} item - 原始采集数据
 * @returns {Object} { category: string, tags: string[] }
 */
const classifyVideo = (item) => {
  // 1. 数据清洗预处理 (转大写方便匹配英文关键词)
  const rawType = (item.type_name || item.original_type || "").trim()
  const rawName = (item.vod_name || item.title || "").trim().toUpperCase()
  const remarks = (item.vod_remarks || item.remarks || "").trim().toUpperCase()
  const playUrl = item.vod_play_url || ""
  const area = (item.vod_area || item.area || "").trim()
  const yearStr = (item.vod_year || item.year || "").toString().trim()

  // 🛡️ 0. 黑名单拦截 (过滤垃圾数据)
  // 如果返回 null，Server端应拒绝入库
  if (
    /短剧|爽文|微剧|赘婿|战神|解说|写真|伦理|福利/.test(rawType) ||
    /短剧|爽文|AV/.test(rawName)
  ) {
    return null
  }

  let category = "movie" // 默认兜底为电影
  let tags = []

  // ==========================================
  // 🏷️ 1. 大类判定 (Category)
  // ==========================================

  // 体育 (扩展关键词)
  if (
    /体育|赛事|足球|篮球|NBA|F1|英超|西甲|欧冠|CBA|奥运|WWE|UFC/.test(
      rawType
    ) ||
    /NBA|F1|CBA|VS/.test(rawName)
  ) {
    category = "sports"
  }
  // 动漫 (包含 动漫、动画、日漫、国漫)
  else if (/动(漫|画)/.test(rawType)) {
    category = "anime"
  }
  // 综艺 (包含 综艺、晚会、真人秀)
  else if (/综艺|晚会|秀|演唱会/.test(rawType)) {
    category = "variety"
  }
  // 纪录片
  else if (/记录|纪录/.test(rawType)) {
    category = "doc"
  }
  // 剧集 vs 电影 (逻辑保持强校验)
  else {
    const isExplicitMovie =
      /剧情片|电影|微电影|大片/.test(rawType) ||
      (/片/.test(rawType) && !/剧/.test(rawType))

    const isExplicitTv = /剧/.test(rawType) && !/剧情片/.test(rawType)

    // 智能判定：如果名字里没有明确标识，但集数大于2，大概率是剧集
    const isMultiEpisode = countEpisodes(playUrl) > 2

    if (isExplicitTv || (isMultiEpisode && !isExplicitMovie)) {
      category = "tv"
    } else {
      category = "movie"
    }
  }

  // ==========================================
  // 🏷️ 2. 题材标签提取 (Genre Tags)
  // ==========================================

  // 将原始分类作为第一个标签 (去除了"电影"、"片"等废话)
  let cleanType = rawType.replace(/电影|连续剧|片|剧|场|频道/g, "")
  if (
    cleanType &&
    cleanType.length > 1 &&
    cleanType !== "国产" &&
    cleanType !== "海外"
  ) {
    tags.push(cleanType)
  }

  // 🔥 强力题材匹配表 (只要标题、分类、备注里有，就打标签)
  const genreMap = {
    动作: /动作|武侠|功夫|枪战|格斗|特工|营救/,
    犯罪: /犯罪|刑侦|警匪|黑帮|卧底|涉案|缉毒/,
    科幻: /科幻|魔幻|异能|太空|末日|变异/,
    悬疑: /悬疑|惊悚|迷案|探案|烧脑/,
    恐怖: /恐怖|惊悚|灵异|丧尸|鬼片/,
    喜剧: /喜剧|搞笑|爆笑|相声|小品/,
    爱情: /爱情|恋爱|甜宠|都市|言情|偶像/,
    战争: /战争|军旅|抗日|谍战|二战/,
    古装: /古装|宫廷|穿越|神话|历史/,
    奇幻: /奇幻|仙侠|玄幻|妖魔/,
    灾难: /灾难|逃生|巨兽/,
    冒险: /冒险|探险|寻宝/,
  }

  // 扫描文本
  const combinedText = `${rawType} ${rawName} ${remarks}`
  for (const [tag, regex] of Object.entries(genreMap)) {
    if (regex.test(combinedText)) {
      tags.push(tag)
    }
  }

  // ==========================================
  // 🏷️ 3. 特殊属性标签 (4K, Netflix, 蓝光)
  // ==========================================

  // 💎 画质标签
  if (/4K|2160P|HDR/.test(combinedText)) {
    tags.push("4K")
  } else if (/1080P|FHD|蓝光/.test(combinedText)) {
    tags.push("蓝光")
  }

  // 🎬 平台标签 (采集源通常会在标题或备注里写 NF/Netflix)
  if (/NETFLIX|奈飞|网飞|NF\b/.test(combinedText)) {
    tags.push("Netflix")
  } else if (/DISNEY|迪士尼/.test(combinedText)) {
    tags.push("Disney+")
  } else if (/HBO/.test(combinedText)) {
    tags.push("HBO")
  } else if (/APPLE TV|\bATV\b/.test(combinedText)) {
    tags.push("Apple TV+")
  }

  // ==========================================
  // 🏷️ 4. 地区标签 (Area)
  // ==========================================
  if (area) {
    if (area.includes("大陆") || area.includes("中国") || area.includes("内地"))
      tags.push("国产")
    else if (area.includes("香港"))
      tags.push("港剧") // 习惯叫法，虽然可能是电影
    else if (area.includes("台湾")) tags.push("台剧")
    else if (area.includes("美国") || area.includes("欧美")) tags.push("欧美")
    else if (area.includes("韩国")) tags.push("韩剧")
    else if (area.includes("日本")) tags.push("日剧")
    else if (area.includes("泰国")) tags.push("泰剧")
  }

  // 修正标签逻辑: 如果是动漫分类，把 "日剧" 修正为 "日漫"
  if (category === "anime") {
    if (tags.includes("日剧")) {
      tags = tags.filter((t) => t !== "日剧")
      tags.push("日漫")
    }
    if (tags.includes("国产")) {
      tags = tags.filter((t) => t !== "国产")
      tags.push("国漫")
    }
  }

  // ==========================================
  // 🏷️ 5. 年份标签 (Year)
  // ==========================================
  // 只有合理的年份才作为标签
  if (/^(19|20)\d{2}$/.test(yearStr)) {
    tags.push(yearStr)
  }

  // 标记 "新片" (今年或去年)
  const currentYear = new Date().getFullYear()
  if (parseInt(yearStr) >= currentYear - 1) {
    tags.push("新片")
  }

  return {
    category,
    tags: [...new Set(tags)], // 去重
  }
}

module.exports = { classifyVideo }
