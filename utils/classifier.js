// utils/classifier.js

/**
 * 🧹 智能分类与打标系统 (增强版)
 * 1. 强力屏蔽成人/违规内容
 * 2. 修复分类不准的问题
 */

// 🚫 黑名单关键词 (出现这些词直接丢弃)
const BLACKLIST = [
  "解说",
  "写真",
  "只有神",
  "av",
  "AV",
  "色情",
  "露点",
  "激情",
  "成人",
  "R级",
  "情色",
  "测试",
  "公告",
]

// 🚫 黑名单分类ID (有些源站会把伦理片放在特定ID，如 20, 30, 34 等，需根据源站实际情况调整)
// 茅台资源通常 ID 34 是伦理片
const BLOCK_TYPE_IDS = [34, 35, 40, 41]

const classifyVideo = (item) => {
  const typeId = parseInt(item.type_id)
  const typeName = item.type_name || ""
  const name = item.vod_name || ""
  const content = (item.vod_content || "").replace(/<[^>]+>/g, "") // 去除HTML
  const remarks = item.vod_remarks || ""
  const area = item.vod_area || ""
  const year = parseInt(item.vod_year) || 0

  // ===============================================
  // 🛑 1. 熔断机制：黑名单检查
  // ===============================================

  // 检查 ID 是否在屏蔽列表
  if (BLOCK_TYPE_IDS.includes(typeId)) return null

  // 检查 标题/分类/简介 是否包含黑名单词汇
  const combinedText = `${typeName} ${name}`.toLowerCase() // 简介容易误杀，暂时只查标题和分类
  if (
    BLACKLIST.some((keyword) => combinedText.includes(keyword.toLowerCase()))
  ) {
    return null // 返回 null 表示这条数据直接丢弃
  }

  // ===============================================
  // 🏷️ 2. 确定标准大类 (Category)
  // ===============================================
  let category = "other"

  // 动漫
  if ([4].includes(typeId) || /动漫|动画/.test(typeName)) {
    category = "anime"
  }
  // 综艺
  else if ([3].includes(typeId) || /综艺|晚会/.test(typeName)) {
    category = "variety"
  }
  // 体育
  else if (/体育|赛事|NBA|足球|篮球/.test(typeName)) {
    category = "sports"
  }
  // 剧集 (严防把“伦理剧”归进来)
  else if (
    [2, 13, 14, 15, 16].includes(typeId) ||
    (/剧/.test(typeName) && !/伦理/.test(typeName))
  ) {
    category = "tv"
  }
  // 电影 (严防把“福利片”归进来)
  else if (
    [1, 6, 7, 8, 9, 10, 11, 12].includes(typeId) ||
    /片|电影/.test(typeName)
  ) {
    category = "movie"
  }

  // 如果经过一轮筛选还是 other，且 type_id 很大，极有可能是杂乱资源，建议直接丢弃
  if (category === "other" && typeId > 50) return null

  // ===============================================
  // 🏷️ 3. 生成智能标签 (Tags)
  // ===============================================
  let tags = new Set()

  // --- A. 平台/厂牌 ---
  if (/Netflix|网飞/i.test(name) || /Netflix|网飞/i.test(content))
    tags.add("netflix")
  if (/HBO/.test(name)) tags.add("hbo")
  if (/Disney/.test(name)) tags.add("disney")
  if (/B站|哔哩哔哩/.test(name)) tags.add("bilibili")

  // --- B. 画质 ---
  if (/4K|2160P/i.test(name) || /4K/i.test(remarks)) tags.add("4k")
  else if (/1080P/i.test(name)) tags.add("1080p")

  // --- C. 类型 ---
  const genreMap = {
    动作: /动作|格斗|武侠|特工/,
    喜剧: /喜剧|搞笑/,
    爱情: /爱情|恋爱|甜宠/,
    科幻: /科幻|太空|未来/,
    恐怖: /恐怖|惊悚|灵异|丧尸/,
    悬疑: /悬疑|推理|探案/,
    战争: /战争|抗日/,
    古装: /古装|宫廷|仙侠/,
    短剧: /短剧|短视频/,
  }

  for (const [tag, regex] of Object.entries(genreMap)) {
    if (regex.test(typeName) || regex.test(name)) {
      tags.add(tag)
    }
  }

  // --- D. 地区 ---
  if (/大陆|内地|中国/.test(area)) tags.add("国产")
  if (/香港/.test(area)) tags.add("港剧")
  if (/美国|英国|欧美/.test(area)) tags.add("欧美")
  if (/韩国/.test(area)) tags.add("韩剧")
  if (/日本/.test(area)) tags.add("日剧")

  // --- E. 时间/状态 (修正：严防老片标新片) ---
  const currentYear = new Date().getFullYear()
  // 只有 2024/2025/2026 的片子，且必须是“电影”或“剧集”才打 new_arrival
  if (
    (year === currentYear || year === currentYear + 1) &&
    (category === "movie" || category === "tv")
  ) {
    tags.add("new_arrival")
  }

  if (/完结|全\d+集/.test(remarks)) tags.add("finished")

  // --- F. 评分 ---
  const score = parseFloat(item.vod_score || 0)
  if (score >= 8.0) tags.add("high_score")

  // 特殊修正：短剧归类
  if (typeName.includes("短剧")) {
    category = "tv"
    tags.add("miniseries")
  }

  return {
    category,
    tags: Array.from(tags),
  }
}

module.exports = { classifyVideo }
