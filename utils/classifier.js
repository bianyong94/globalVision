// utils/classifier.js

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
  "三级",
  "伦理",
  "福利",
  "金瓶",
]

const BLOCK_TYPE_IDS = [34, 35, 40, 41]

const classifyVideo = (item) => {
  const typeId = parseInt(item.type_id)
  const typeName = item.type_name || ""
  const name = item.vod_name || ""
  const content = (item.vod_content || "").replace(/<[^>]+>/g, "").toLowerCase()
  const remarks = item.vod_remarks || ""
  const area = item.vod_area || ""
  const year = parseInt(item.vod_year) || 0

  // 1. 黑名单熔断
  if (BLOCK_TYPE_IDS.includes(typeId)) return null
  const combinedText = `${typeName} ${name}`.toLowerCase()
  if (
    BLACKLIST.some((keyword) => combinedText.includes(keyword.toLowerCase()))
  ) {
    return null
  }

  // ==========================================
  // 🔥🔥🔥 核心修改区域开始 🔥🔥🔥
  // ==========================================
  let category = "other"

  // 1. 动漫
  if ([4].includes(typeId) || /动漫|动画/.test(typeName)) {
    category = "anime"
  }
  // 2. 综艺
  else if ([3].includes(typeId) || /综艺|晚会/.test(typeName)) {
    category = "variety"
  }
  // 3. 体育
  else if (/体育|赛事|NBA|足球|篮球/.test(typeName)) {
    category = "sports"
  }
  // 4. 🔥 电影 (必须放在剧集前面！)
  // 逻辑：只要带“片”或者“电影”，先归为 movie
  // 这能解决 "剧情片" 被误判为 tv 的问题
  else if (
    [1, 6, 7, 8, 9, 10, 11, 12].includes(typeId) ||
    /片|电影/.test(typeName)
  ) {
    category = "movie"
  }
  // 5. 剧集 (剩下的带“剧”字的才是剧集)
  else if (
    [2, 13, 14, 15, 16].includes(typeId) ||
    (/剧/.test(typeName) && !/伦理/.test(typeName))
  ) {
    category = "tv"
  }
  // ==========================================
  // 🔥🔥🔥 核心修改区域结束 🔥🔥🔥
  // ==========================================

  // 兜底清洗
  if (category === "other" && typeId > 50) return null

  // 3. 生成标签
  let tags = new Set()

  // A. 平台
  if (/Netflix|网飞/i.test(name) || /Netflix|网飞/i.test(content))
    tags.add("netflix")
  if (/HBO/.test(name)) tags.add("hbo")
  if (/Disney/.test(name)) tags.add("disney")
  if (/B站|哔哩哔哩/.test(name)) tags.add("bilibili")

  // B. 画质
  if (/4K|2160P/i.test(name) || /4K/i.test(remarks)) tags.add("4k")
  else if (/1080P/i.test(name)) tags.add("1080p")

  // C. 类型
  const genreMap = {
    动作: /动作|格斗|武侠|特工|功夫|枪战/,
    喜剧: /喜剧|搞笑|相声|小品|开心/,
    爱情: /爱情|恋爱|甜宠|浪漫|情感/,
    科幻: /科幻|太空|未来|赛博|超能力|外星/,
    恐怖: /恐怖|惊悚|灵异|丧尸|鬼片|惊魂/,
    悬疑: /悬疑|推理|探案|烧脑|谜案/,
    战争: /战争|抗日|二战|谍战|军旅/,
    古装: /古装|宫廷|仙侠|武侠|玄幻|穿越/,
    灾难: /灾难|末日|求生|大逃杀|地震|海啸|台风|火山|龙卷风|陨石|病毒|感染|变异|沉没|崩塌|怪兽|狂暴/,
    犯罪: /犯罪|警匪|黑帮|卧底|缉毒|扫黑|抢劫|越狱|杀手|神探|破案|刑侦|反贪|洗钱|黑道/,
    剧情: /剧情|文艺|传记|历史|生活/, // 🔥 确保这里有剧情标签
    短剧: /短剧|短视频/,
  }

  for (const [tag, regex] of Object.entries(genreMap)) {
    if (regex.test(typeName) || regex.test(name)) {
      tags.add(tag)
    }
  }

  // D. 地区
  if (/大陆|内地|中国/.test(area)) tags.add("国产")
  if (/香港/.test(area)) tags.add("港剧")
  if (/美国|英国|欧美/.test(area)) tags.add("欧美")
  if (/韩国/.test(area)) tags.add("韩剧")
  if (/日本/.test(area)) tags.add("日剧")

  // E. 时间
  const currentYear = new Date().getFullYear()
  if (
    (year === currentYear || year === currentYear + 1) &&
    (category === "movie" || category === "tv")
  ) {
    tags.add("new_arrival")
  }
  if (/完结|全\d+集/.test(remarks)) tags.add("finished")

  // F. 评分
  const score = parseFloat(item.vod_score || 0)
  if (score >= 8.0) tags.add("high_score")

  if (typeName.includes("短剧")) {
    category = "tv"
    tags.add("miniseries")
  }

  return { category, tags: Array.from(tags) }
}

module.exports = { classifyVideo }
