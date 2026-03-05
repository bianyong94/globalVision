const User = require("../models/User")
const Video = require("../models/Video")
const mongoose = require("mongoose")

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

const hasSeasonMarker = (text = "") =>
  /(第\s*[一二两三四五六七八九十百\d]+\s*[季部]|Season\s*\d+|S\d{1,2})/i.test(
    String(text),
  )

const extractSeasonLabel = (text = "") => {
  const match = String(text).match(
    /第\s*[一二两三四五六七八九十百\d]+\s*[季部]|Season\s*\d+|S\d{1,2}/i,
  )
  return match ? String(match[0]).trim() : ""
}

const buildHistoryKey = (video = {}) => {
  const baseId = String(video.id || "").trim()
  const season = String(video.seasonLabel || "").trim()
  const sourceRef = String(video.sourceRef || "").trim()
  const suffix = season || sourceRef || "default"
  return `${baseId}::${suffix}`
}

exports.register = async (req, res) => {
  const { username, password } = req.body
  try {
    const existing = await User.findOne({ username })
    if (existing) return fail(res, "用户已存在", 400)
    const newUser = new User({ username, password }) // 生产环境请加密密码
    await newUser.save()
    success(res, { id: newUser._id, username })
  } catch (e) {
    fail(res, "注册失败")
  }
}
exports.login = async (req, res) => {
  const { username, password } = req.body
  try {
    const user = await User.findOne({ username, password })
    if (!user) return fail(res, "账号或密码错误", 401)
    success(res, { id: user._id, username: user.username })
  } catch (e) {
    fail(res, "登录失败")
  }
}
exports.getHistory = async (req, res) => {
  const { username } = req.query
  if (!username) return success(res, [])

  try {
    const user = await User.findOne({ username })
    if (!user || !user.history || user.history.length === 0) {
      return success(res, [])
    }

    // 1. 提取所有历史记录的 ID
    const historyIds = user.history.map((h) => h.id)

    // 2. 批量去 Video 表查最新的海报、标题
    // (只查需要的字段，速度极快)
    const objectIds = historyIds.filter((id) =>
      mongoose.Types.ObjectId.isValid(id),
    )
    const freshVideos = await Video.find({
      $or: [{ uniq_id: { $in: historyIds } }, { _id: { $in: objectIds } }],
    })
      .select("uniq_id poster pic title")
      .lean()

    // 3. 转成 Map 方便快速匹配
    const videoMap = {}
    freshVideos.forEach((v) => {
      videoMap[v.uniq_id] = v
      if (v._id) {
        videoMap[String(v._id)] = v
      }
    })

    // 4. 组装最终数据 (合并逻辑)
    const enrichedHistory = user.history.map((historyItem) => {
      // 尝试找到最新的视频信息
      const freshInfo = videoMap[historyItem.id]

      return {
        ...historyItem, // 保留进度(progress)、观看时间(viewedAt)等

        // 🔥 核心修复：优先用最新库里的海报，没有则用历史存的，还不行就给空
        poster:
          (freshInfo && (freshInfo.poster || freshInfo.pic)) ||
          historyItem.poster ||
          historyItem.pic ||
          "",

        // 顺便也更新一下标题，防止片名变更
        title:
          hasSeasonMarker(historyItem.title) || historyItem.seasonLabel
            ? historyItem.title
            : freshInfo
              ? freshInfo.title
              : historyItem.title,
        seasonLabel: historyItem.seasonLabel || extractSeasonLabel(historyItem.title),
      }
    })

    // 5. 过滤掉完全没数据且没标题的坏数据
    const validHistory = enrichedHistory.filter((h) => h && h.title)

    success(res, validHistory)
  } catch (e) {
    console.error("Get History Error:", e)
    success(res, []) // 失败降级返回空，防止前端报错
  }
}
exports.addHistory = async (req, res) => {
  const { username, video, episodeIndex, progress } = req.body

  // 基础校验
  if (!username || !video || !video.id) {
    return fail(res, "参数错误: 缺少 username 或 video.id", 400)
  }

  try {
    const user = await User.findOne({ username })
    if (!user) return fail(res, "用户不存在", 404)

    const targetId = String(video.id)
    const targetHistoryKey = buildHistoryKey(video)

    // 1. 过滤掉已存在的同一部片子 (避免重复，把旧的删了加新的到最前面)
    let newHistory = (user.history || []).filter(
      (h) =>
        String(h.historyKey || `${h.id}::${h.seasonLabel || h.sourceRef || "default"}`) !==
        targetHistoryKey
    )

    // 2. 构造新的记录对象
    // 🔥 关键点：确保 poster 字段有值
    const posterUrl = video.poster || video.pic || ""

    const historyItem = {
      id: targetId,
      historyKey: targetHistoryKey,
      title: video.title || "未知片名",
      poster: posterUrl, // 强制统一字段名为 poster
      pic: posterUrl, // 兼容旧字段
      seasonLabel: video.seasonLabel || "",
      sourceRef: video.sourceRef || "",
      episodeIndex: parseInt(episodeIndex) || 0,
      progress: parseFloat(progress) || 0,
      viewedAt: new Date().toISOString(),
      // 如果有其他字段想存（比如当前集数名），也可以解构进去
      // ...video
    }

    // 3. 插入到数组开头 (最近观看)
    newHistory.unshift(historyItem)

    // 4. 限制长度 (只存最近 100 条)
    user.history = newHistory.slice(0, 100)

    // 告诉 Mongoose 数组有变化
    user.markModified("history")
    await user.save()

    success(res, user.history)
  } catch (e) {
    console.error("Save History Error:", e)
    fail(res, "保存失败")
  }
}
exports.clearHistory = async (req, res) => {
  const { username } = req.query
  try {
    const user = await User.findOne({ username })
    if (user) {
      user.history = []
      user.markModified("history")
      await user.save()
    }
    success(res, [])
  } catch (e) {
    fail(res, "清空失败")
  }
}
