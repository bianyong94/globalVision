const mongoose = require("mongoose")

// 定义子文档：资源源 (Source)
// 这是为了实现“一部电影，多个播放源”的核心结构
const SourceSchema = new mongoose.Schema({
  source_key: { type: String, required: true }, // 源标识，如 "hongniu", "feifan"
  vod_id: { type: String, required: true }, // 采集站那边的 ID
  vod_name: String, // 采集站那边的标题 (用于对比)
  vod_play_from: String, // 播放器类型 (如 "m3u8", "ddzy")
  vod_play_url: { type: String, required: true }, // 播放列表字符串
  remarks: String, // 更新状态 (如 "更新至10集", "HD中字")
  priority: { type: Number, default: 0 }, // 优先级 (比如清洗过的高清源排前面)
  updatedAt: { type: Date, default: Date.now }, // 该源最后更新时间
})

// 主文档：影视条目 (Video)
const VideoSchema = new mongoose.Schema(
  {
    // ==========================================
    // 1. 核心身份认证 (Identity)
    // ==========================================
    // TMDB ID 是聚合的核心。unique: true 保证同一个电影数据库里只有一条记录
    tmdb_id: { type: Number, unique: true, index: true, sparse: true },

    // 如果没有 TMDB ID (比如某些微短剧)，用这个作为备用唯一标识
    // 格式建议: "custom_MD5(title+year)" 或直接用 MongoDB _id
    custom_id: { type: String, index: true, sparse: true },

    // ==========================================
    // 2. 展示元数据 (Metadata) - 以 TMDB 为准
    // ==========================================
    title: { type: String, required: true, index: true }, // 标准中文名
    original_title: String, // 原名 (英文/日文)

    // 你的 Server.js 强依赖这些字段进行筛选
    category: {
      type: String,
      required: true,
      enum: ["movie", "tv", "anime", "variety", "sports", "other"], // 规范化分类
      index: true,
    },

    year: { type: Number, index: true }, // 年份 (2024)
    date: String, // 具体上映日期 (2024-05-16)

    // 丰富详情 (保留你之前的定义)
    actors: { type: String, index: true }, // 演员字符串 "张若昀, 李沁"
    director: String, // 导演
    writer: String, // 编剧
    area: String, // 地区 "中国大陆"
    language: String, // 语言
    duration: String, // 时长

    overview: String, // 简介

    // 图片系统
    poster: String, // 竖版海报 (TMDB Link)
    backdrop: String, // 横版大图 (用于首页 Banner)

    // ==========================================
    // 3. 核心功能字段 (Logic)
    // ==========================================
    // 评分系统
    rating: { type: Number, default: 0, index: true }, // TMDB 评分
    vote_count: { type: Number, default: 0 }, // 评分人数 (防止只有1个人评10分)

    // 🔥 标签系统 (用于 "Netflix", "4K", "短剧" 筛选)
    tags: { type: [String], index: true },

    // 状态标记
    is_enriched: { type: Boolean, default: false }, // 是否已完成 TMDB 精修
    is_locked: { type: Boolean, default: false }, // 是否人工锁定 (防止被采集脚本覆盖)

    // ==========================================
    // 4. 资源聚合挂载点 (Aggregation)
    // ==========================================
    // 这里不再存单独的 vod_play_url，而是存一个数组
    sources: [SourceSchema],

    // 辅助字段：最新更新的源的 remarks (方便列表页显示 "更新至8集")
    latest_remarks: String,
  },
  {
    timestamps: true, // 自动维护 createdAt, updatedAt
    minimize: false, // 防止空对象被忽略
  }
)

// ==========================================
// 5. 索引优化 (Indexing)
// ==========================================

// 列表页筛选常用组合
VideoSchema.index({ category: 1, year: -1, rating: -1 })
VideoSchema.index({ category: 1, tags: 1, updatedAt: -1 })

// 搜索优化 (支持 标题、演员、导演、原名 搜索)
// 注意：MongoDB Text Search 对中文支持一般，建议结合 regex 使用
VideoSchema.index(
  {
    title: "text",
    original_title: "text",
    actors: "text",
    director: "text",
  },
  {
    weights: { title: 10, original_title: 5, actors: 3, director: 1 },
  }
)

module.exports = mongoose.model("Video", VideoSchema)
