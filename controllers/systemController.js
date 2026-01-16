const { smartFetch } = require("../services/videoService")
const { getCache, setCache } = require("../utils/cache")
const { STANDARD_GROUPS, BLACK_LIST } = require("../config/constants")
const axios = require("axios")
const AI_API_KEY = process.env.AI_API_KEY
const AI_API_URL = "https://api.siliconflow.cn/v1/chat/completions"

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

exports.getCategories = async (req, res) => {
  const cacheKey = "categories_auto_washed_v2"
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    const result = await smartFetch(() => ({ ac: "list", at: "json" }))
    if (!result || !result.data || !result.data.class)
      throw new Error("No data")

    const rawList = result.data.class

    // 预设父类
    const washedList = [
      { type_id: 1, type_pid: 0, type_name: "电影" },
      { type_id: 2, type_pid: 0, type_name: "剧集" },
      { type_id: 3, type_pid: 0, type_name: "综艺" },
      { type_id: 4, type_pid: 0, type_name: "动漫" },
      { type_id: 5, type_pid: 0, type_name: "体育" },
    ]

    rawList.forEach((item) => {
      const name = item.type_name
      const id = parseInt(item.type_id)

      if (BLACK_LIST.some((bad) => name.includes(bad))) return
      if (["电影", "电视剧", "连续剧", "综艺", "动漫", "体育"].includes(name))
        return

      let targetPid = 0

      // 正则匹配名字
      if (STANDARD_GROUPS.SPORTS.regex.test(name)) targetPid = 5
      else if (STANDARD_GROUPS.ANIME.regex.test(name)) targetPid = 4
      else if (STANDARD_GROUPS.VARIETY.regex.test(name)) targetPid = 3
      else if (STANDARD_GROUPS.TV.regex.test(name)) targetPid = 2
      else if (STANDARD_GROUPS.MOVIE.regex.test(name)) targetPid = 1

      // 兜底：根据 ID 范围猜测
      if (targetPid === 0) {
        if (id >= 6 && id <= 12) targetPid = 1
        else if (id >= 13 && id <= 24) targetPid = 2
        else if (id >= 25 && id <= 29) targetPid = 3
        else if (id >= 30 && id <= 34) targetPid = 4
        else targetPid = 999
      }

      washedList.push({ type_id: id, type_name: name, type_pid: targetPid })
    })

    await setCache(cacheKey, washedList, 86400)
    success(res, washedList)
  } catch (e) {
    success(res, [
      { type_id: 1, type_pid: 0, type_name: "电影" },
      { type_id: 2, type_pid: 0, type_name: "剧集" },
      { type_id: 3, type_pid: 0, type_name: "综艺" },
      { type_id: 4, type_pid: 0, type_name: "动漫" },
    ])
  }
}

exports.askAI = async (req, res) => {
  const { question } = req.body
  if (!AI_API_KEY) return fail(res, "AI Key Missing", 500)

  try {
    const response = await axios.post(
      AI_API_URL,
      {
        model: "deepseek-ai/DeepSeek-V3",
        messages: [
          {
            role: "system",
            content:
              "你是一个影视搜索助手。请直接推荐3-5个相关的国内上映的影片中文名称，用逗号分隔，不要有任何多余文字。",
          },
          { role: "user", content: question },
        ],
        stream: false,
        max_tokens: 100,
      },
      { headers: { Authorization: `Bearer ${AI_API_KEY}` } }
    )
    const content = response.data.choices[0].message.content
    const list = content
      .replace(/[。.!！《》\n]/g, "")
      .split(/,|，/)
      .map((s) => s.trim())
      .filter((s) => s)
    success(res, list)
  } catch (error) {
    success(res, ["庆余年2", "抓娃娃", "热辣滚烫"])
  }
}
