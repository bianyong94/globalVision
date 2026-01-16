/**
 * utils/classifier.js
 * 核心分类与标签提取器
 */

// 辅助：计算集数
const countEpisodes = (urlStr) => {
  if (!urlStr) return 0
  // 兼容: "第1集$url#第2集$url" 或 "url1#url2"
  // 注意：有些资源站只返回 "PV$url"，这种集数为 1
  return urlStr.split("#").length
}

/**
 * 核心分类函数
 * 将混乱的采集数据清洗为标准格式
 * @param {Object} item - 原始采集数据 (vod_name, type_name, ...)
 * @returns {Object|null} - 返回 { category, tags }，如果是垃圾数据返回 null
 */
const classifyVideo = (item) => {
  // 1. 数据清洗预处理 (转大写方便匹配)
  const rawType = (item.type_name || item.original_type || "").trim() // e.g. "动作片", "国产剧"
  const rawName = (item.vod_name || item.title || "").trim().toUpperCase() // e.g. "钢铁侠"
  const remarks = (item.vod_remarks || item.remarks || "").trim().toUpperCase() // e.g. "HD中字"
  const playUrl = item.vod_play_url || ""
  const area = (item.vod_area || item.area || "").trim()
  const yearStr = (item.vod_year || item.year || "").toString().trim()

  // 🛡️ 0. 黑名单拦截 (过滤垃圾数据)
  // 针对 "伦理", "福利", "解说" 等绝对不要的内容
  if (/福利|写真|解说/.test(rawType) || /AV|三级|解说/.test(rawName)) {
    return null
  }

  // ⚠️ 软黑名单：目前即使是 "短剧" 也很火，建议不直接拦截，而是打标分类
  // 如果确定完全不想要短剧，可以在这里加拦截
  // if (/短剧|赘婿/.test(rawType)) return null;

  let category = "movie" // 默认兜底
  let tags = []

  // ==========================================
  // 🏷️ 1. 大类判定 (Category)
  // ==========================================

  // A. 体育 (Sports)
  if (
    /体育|赛事|足球|篮球|NBA|F1|英超|西甲|欧冠|CBA|奥运|WWE|UFC/.test(
      rawType
    ) ||
    /NBA|F1|CBA|VS/.test(rawName)
  ) {
    category = "sports"
  }
  // B. 动漫 (Anime) - 优先级高
  else if (/动(漫|画)/.test(rawType)) {
    category = "anime"
  }
  // C. 综艺 (Variety)
  else if (/综艺|晚会|秀|演唱会/.test(rawType)) {
    category = "variety"
  }
  // D. 纪录片 (Documentary) -> 归入 movie 或 variety 取决于业务，这里单列 tag，大类归 movie
  else if (/记录|纪录/.test(rawType)) {
    category = "movie"
    tags.push("纪录片")
  }
  // E. 剧集判定 (TV vs Movie) - 核心逻辑
  else {
    // 包含 "剧" 但不包含 "剧情片"、"喜剧片"、"悲剧" 等电影常用词
    const hasJu = /剧/.test(rawType)
    const isMovieKeyword = /片|电影|微电影/.test(rawType)

    // 特例："喜剧片" 包含 "剧"，但它是电影
    // 特例："剧情片" 包含 "剧"，但它是电影
    const isFalsePositive = /剧情|喜剧|悲剧|歌剧|默剧/.test(rawType)

    const isExplicitTv = hasJu && !isFalsePositive

    // 智能判定：如果分类含糊(如"国产"没说剧还是片)，看集数
    const isMultiEpisode = countEpisodes(playUrl) > 2

    if (isExplicitTv || (isMultiEpisode && !isMovieKeyword)) {
      category = "tv"
    } else {
      category = "movie"
    }
  }

  // ==========================================
  // 🏷️ 2. 题材标签提取 (Genre)
  // ==========================================

  // 清理 type_name 中的废话
  let cleanType = rawType.replace(/电影|连续剧|片|剧|场|频道|专区/g, "")
  // 排除 "国产", "海外", "欧美" 这种只是地区的词，我们后面单独处理地区
  if (
    cleanType &&
    cleanType.length > 1 &&
    !/国产|海外|欧美|日韩|港台/.test(cleanType)
  ) {
    tags.push(cleanType)
  }

  // 强力题材匹配
  const genreMap = {
    动作: /动作|武侠|功夫|枪战|格斗|特工|营救/,
    犯罪: /犯罪|刑侦|警匪|黑帮|卧底|涉案|缉毒/,
    科幻: /科幻|魔幻|异能|太空|末日|变异|超英|漫威/,
    悬疑: /悬疑|惊悚|迷案|探案|烧脑|推理/,
    恐怖: /恐怖|惊悚|灵异|丧尸|鬼片/,
    喜剧: /喜剧|搞笑|爆笑|相声|小品|脱口秀/,
    爱情: /爱情|恋爱|甜宠|都市|言情|偶像|纯爱/,
    战争: /战争|军旅|抗日|谍战|二战/,
    古装: /古装|宫廷|穿越|神话|历史|武侠/,
    奇幻: /奇幻|仙侠|玄幻|妖魔/,
    灾难: /灾难|逃生|巨兽/,
    冒险: /冒险|探险|寻宝/,
    短剧: /短剧|微剧|爽文|赘婿/, // 专门给短剧打标
  }

  const combinedText = `${rawType} ${rawName} ${remarks}`
  for (const [tag, regex] of Object.entries(genreMap)) {
    if (regex.test(combinedText)) {
      tags.push(tag)
    }
  }

  // 修正：如果被识别为 "短剧"，强制把 category 改为 'tv' (如果之前误判为 movie 的话)
  if (tags.includes("短剧") && category === "movie") {
    // 除非它真的是 "微电影"
    if (!/微电影/.test(rawType)) {
      category = "tv"
    }
  }

  // ==========================================
  // 🏷️ 3. 特殊属性 (Quality, Platform)
  // ==========================================

  if (/4K|2160P|HDR/.test(combinedText)) tags.push("4K")
  else if (/1080P|FHD|蓝光/.test(combinedText)) tags.push("蓝光")

  // 平台标签 (支持搜索 filter: "netflix")
  if (/NETFLIX|奈飞|网飞|NF\b/.test(combinedText)) tags.push("Netflix")
  if (/DISNEY|迪士尼/.test(combinedText)) tags.push("Disney+")
  if (/HBO/.test(combinedText)) tags.push("HBO")
  if (/APPLE TV|\bATV\b/.test(combinedText)) tags.push("Apple TV+")
  if (/BILIBILI|B站/.test(combinedText)) tags.push("Bilibili")

  // ==========================================
  // 🏷️ 4. 地区标签 (Area)
  // ==========================================
  // 优先用 vod_area 字段，没有的话从 type_name 猜
  let areaTag = ""
  const areaText = `${area} ${rawType}`

  if (/大陆|中国|内地|国产/.test(areaText)) areaTag = "国产"
  else if (/香港|港剧/.test(areaText))
    areaTag = "港剧" // 注意：这里仅作标签，category 还是 tv/movie
  else if (/台湾|台剧/.test(areaText)) areaTag = "台剧"
  else if (/美国|欧美|西洋/.test(areaText)) areaTag = "欧美"
  else if (/韩国|韩剧/.test(areaText)) areaTag = "韩剧"
  else if (/日本|日剧/.test(areaText)) areaTag = "日剧"
  else if (/泰国|泰剧/.test(areaText)) areaTag = "泰剧"

  if (areaTag) {
    // 动漫特殊修正
    if (category === "anime") {
      if (areaTag === "日剧") areaTag = "日漫"
      if (areaTag === "国产") areaTag = "国漫"
      if (areaTag === "欧美") areaTag = "欧美漫"
    }
    // 电影特殊修正 (不要出现 "港剧" 这种标签在电影里)
    if (category === "movie") {
      if (areaTag === "港剧") areaTag = "香港"
      if (areaTag === "台剧") areaTag = "台湾"
      if (areaTag === "韩剧") areaTag = "韩国"
      if (areaTag === "日剧") areaTag = "日本"
    }
    tags.push(areaTag)
  }

  // ==========================================
  // 🏷️ 5. 年份标签 (Year)
  // ==========================================
  const currentYear = new Date().getFullYear()
  if (/^(19|20)\d{2}$/.test(yearStr)) {
    // tags.push(yearStr); // 放在 tags 里可以，或者前端直接读 video.year
    // 标记新片
    if (parseInt(yearStr) >= currentYear - 1) {
      tags.push("新片")
    }
  }

  return {
    category,
    tags: [...new Set(tags)], // 去重
  }
}

module.exports = { classifyVideo }
