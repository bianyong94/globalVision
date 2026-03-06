const parseListEnv = (value = "") =>
  String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

const HARD_ADULT_REGEX =
  /(^|\b)(av|AV在线|成人视频|无码|有码|番号|carib|heyzo|fc2|pornhub|xvideos|国产自拍|偷拍|偷拍自拍|换妻|自拍偷拍|做爱实录)(\b|$)/i
const HARD_TYPE_REGEX = /成人|av|情色写真|福利写真|裸聊|约炮|无码|有码|番号/i
const SOFT_EROTIC_REGEX = /情色|情欲|伦理|禁忌|欲望|香艳|Erotic|Lust/i

const isWhitelisted = (item = {}) => {
  const title = String(item.vod_name || item.title || "")
  const whitelist = parseListEnv(process.env.ADULT_FILTER_WHITELIST_TITLES)
  if (whitelist.length === 0) return false
  return whitelist.some((x) => x && title.includes(x))
}

function evaluateAdultContent(item = {}, sourceKey = "") {
  if (isWhitelisted(item)) {
    return {
      blocked: false,
      isErotic: false,
      level: "whitelist",
      reasons: ["whitelist-title"],
    }
  }

  const title = String(item.vod_name || item.title || "")
  const remarks = String(item.vod_remarks || item.remarks || "")
  const typeName = String(item.type_name || item.original_type || "")
  const actors = String(item.vod_actor || item.actors || "")
  const combined = `${title} ${remarks} ${typeName} ${actors}`

  const adultSourceList = parseListEnv(process.env.ADULT_FILTER_SOURCE_BLACKLIST)
  const hardSourceList =
    adultSourceList.length > 0
      ? adultSourceList
      : ["av", "se", "huang", "porn", "adult"]
  const sourceHit = hardSourceList.some((k) =>
    String(sourceKey || "").toLowerCase().includes(k.toLowerCase()),
  )

  const hardByText = HARD_ADULT_REGEX.test(combined) || HARD_TYPE_REGEX.test(typeName)
  const softErotic = SOFT_EROTIC_REGEX.test(combined)

  // 软情色允许入库，除非同时命中硬色情特征
  const blocked = sourceHit || hardByText

  return {
    blocked,
    isErotic: softErotic && !blocked,
    level: blocked ? "hard" : softErotic ? "soft" : "normal",
    reasons: [
      ...(sourceHit ? ["adult-source"] : []),
      ...(hardByText ? ["hard-adult-keyword"] : []),
      ...(softErotic ? ["soft-erotic-keyword"] : []),
    ],
  }
}

module.exports = {
  evaluateAdultContent,
}
