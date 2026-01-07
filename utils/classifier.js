// utils/classifier.js

/**
 * 🧹 智能分类与打标系统
 * 目标：将杂乱的资源站数据清洗为标准化的 Netflix 风格数据
 */

const classifyVideo = (item) => {
  const typeId = parseInt(item.type_id)
  const typeName = item.type_name || ""
  const name = item.vod_name || ""
  const content = (item.vod_content || "").replace(/<[^>]+>/g, "") // 去除HTML
  const remarks = item.vod_remarks || ""
  const area = item.vod_area || ""
  const year = parseInt(item.vod_year) || 0

  // 1️⃣ 确定标准大类 (Category)
  // 逻辑：ID优先，正则兜底，防止漏网之鱼
  let category = "other" // 默认为其他

  // 动漫 (优先级最高，防止 "国产动漫" 被归为 "国产剧")
  if ([4].includes(typeId) || /动漫|动画|国漫/.test(typeName)) {
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
  // 纪录片
  else if (/纪录|记录/.test(typeName)) {
    category = "doc"
  }
  // 剧集 (包含 短剧)
  else if ([2, 13, 14, 15, 16].includes(typeId) || /剧/.test(typeName)) {
    category = "tv"
  }
  // 电影 (剩下的通常是电影)
  else if (
    [1, 6, 7, 8, 9, 10, 11, 12].includes(typeId) ||
    /片|电影/.test(typeName)
  ) {
    category = "movie"
  }

  // 2️⃣ 生成智能标签 (Tags)
  let tags = new Set() // 使用 Set 自动去重

  // --- A. 平台/厂牌标签 (精装修的关键) ---
  if (/Netflix|网飞/i.test(name) || /Netflix|网飞/i.test(content))
    tags.add("netflix")
  if (/HBO/.test(name) || /HBO/.test(content)) tags.add("hbo")
  if (/Disney|迪士尼/i.test(name)) tags.add("disney")
  if (/Apple/.test(name) || /Apple/.test(content)) tags.add("apple_tv")
  if (/B站|哔哩哔哩/.test(name) || /哔哩哔哩/.test(content))
    tags.add("bilibili")
  if (/腾讯视频/.test(content)) tags.add("tencent")
  if (/爱奇艺/.test(content)) tags.add("iqiyi")

  // --- B. 格式/画质标签 ---
  if (/4K|2160P/i.test(name) || /4K/i.test(remarks)) tags.add("4k")
  else if (/1080P/i.test(name) || /1080P/i.test(remarks)) tags.add("1080p")
  if (/60帧|60FPS/i.test(name)) tags.add("60fps")
  if (/中字|双语/.test(name)) tags.add("subtitled") // 内嵌字幕

  // --- C. 题材/类型标签 (从 type_name 和 name 中提取) ---
  const genreMap = {
    动作: /动作|格斗|武侠|特工/,
    喜剧: /喜剧|搞笑|相声/,
    爱情: /爱情|恋爱|浪漫|甜宠/,
    科幻: /科幻|太空|未来/,
    恐怖: /恐怖|惊悚|灵异|丧尸/,
    犯罪: /犯罪|警匪|黑帮|破案/,
    悬疑: /悬疑|推理|探案/,
    战争: /战争|军旅|抗日/,
    古装: /古装|宫廷|穿越|仙侠|武侠/,
    奇幻: /奇幻|魔幻|神话/,
    灾难: /灾难|末日/,
    短剧: /短剧|短视频/,
  }

  for (const [tag, regex] of Object.entries(genreMap)) {
    if (regex.test(typeName) || regex.test(name)) {
      tags.add(tag)
    }
  }

  // --- D. 地区标签 ---
  if (/大陆|内地|中国/.test(area)) tags.add("国产")
  if (/香港/.test(area)) tags.add("港剧") // 或 港片
  if (/台湾/.test(area)) tags.add("台剧")
  if (/美国|英国|欧美/.test(area)) tags.add("欧美")
  if (/韩国/.test(area)) tags.add("韩剧") // 或 韩片
  if (/日本/.test(area)) tags.add("日剧")

  // --- E. 时间/状态标签 ---
  const currentYear = new Date().getFullYear()
  if (year === currentYear) tags.add("new_arrival") // 今年新片
  if (year === currentYear - 1) tags.add("last_year")
  if (/完结|全\d+集/.test(remarks)) tags.add("finished") // 已完结

  // --- F. 评分标签 (如果有评分数据) ---
  const score = parseFloat(item.vod_score || 0)
  if (score >= 8.0) tags.add("high_score") // 高分神作

  // 3️⃣ 特殊修正
  // 如果是“短剧”，虽然归类在 tv，但我们可以专门打个标方便前端单独提出来
  if (typeName.includes("短剧")) {
    category = "tv"
    tags.add("miniseries") // 短剧专用标
  }

  return {
    category,
    tags: Array.from(tags), // 转回数组
  }
}

module.exports = { classifyVideo }
