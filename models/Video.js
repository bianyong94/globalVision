// models/Video.js
const mongoose = require("mongoose")

const VideoSchema = new mongoose.Schema(
  {
    // 核心唯一ID：格式为 "sourceKey_vod_id" (例如 "maotai_12345")
    // ⚠️ 改名 uniq_id 以区分 MongoDB 自身的 _id，防止混淆
    uniq_id: { type: String, required: true, unique: true, index: true },

    // === 原始数据 (保留用于排查) ===
    vod_id: Number,
    source: String, // 数据源标识 (maotai, feifan)

    // === 清洗后的展示数据 ===
    title: { type: String, index: true },
    director: String,
    actors: { type: String, index: true },

    // ⚠️ 原始分类 (源提供的分类，如 "动作片", "国产剧")
    original_type: String,

    // 🔥🔥🔥 核心升级：标准大类 (用于底部 Tab)
    // 枚举值: movie(电影), tv(剧集), anime(动漫), variety(综艺), doc(纪录片), sports(体育)
    category: { type: String, index: true, required: true },

    // 🔥🔥🔥 核心升级：智能标签 (用于首页金刚区、Netflix专区等)
    // 例如: ["netflix", "4k", "悬疑", "古装", "高分", "2024"]
    tags: { type: [String], index: true },

    poster: String,
    overview: String,
    language: String,
    area: String,
    year: Number, // 格式化为数字方便排序
    date: String, // 原始更新时间字符串

    // 评分：如果没有评分，默认为 0
    rating: { type: Number, default: 0, index: true },

    remarks: String, // 连载状态

    // 播放地址
    vod_play_from: String,
    vod_play_url: String,

    // 系统更新时间
    updatedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true, // 自动管理 createdAt 和 updatedAt
  }
)

// 复合文本索引 (用于全文搜索)
VideoSchema.index({ title: "text", actors: "text", original_type: "text" })
// 复合查询索引 (用于类似 "找美剧+悬疑+按时间排序" 的查询)
VideoSchema.index({ category: 1, tags: 1, updatedAt: -1 })

module.exports = mongoose.model("Video", VideoSchema)
