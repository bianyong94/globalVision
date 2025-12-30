// models/Video.js
const mongoose = require("mongoose")

const VideoSchema = new mongoose.Schema({
  // 核心唯一ID：格式为 "sourceKey$vod_id"，例如 "hongniu$12345"
  id: { type: String, required: true, unique: true, index: true },

  // 基础信息 (存清洗后的数据，方便前端直接用)
  title: { type: String, index: true }, // 建立索引用于搜片名
  director: String,
  actors: { type: String, index: true }, // ✨ 建立索引用于搜演员
  type: String, // 剧情、动作...
  type_id: { type: Number, index: true },
  poster: String,
  overview: String, // 简介
  language: String,
  area: String,
  year: String,
  date: String, // 更新时间
  rating: Number,
  remarks: String, // 更新状态 (如:HD, 更新至8集)

  // 播放地址信息
  // 建议直接存解析好的数组，或者存原始字符串
  vod_play_from: String, // 播放源标识 m3u8$$$youku
  vod_play_url: String, // 播放地址字符串

  // 标记记录更新时间
  updatedAt: { type: Date, default: Date.now },
})

// 复合文本索引 (可选，用于模糊搜索)
VideoSchema.index({ title: "text", actors: "text" })

module.exports = mongoose.model("Video", VideoSchema)
