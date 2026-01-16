const mongoose = require("mongoose")

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
  },
  password: {
    type: String,
    required: true,
    // ⚠️ 注意：生产环境建议在 Controller 中使用 bcrypt 对密码加密后再存储
  },
  // 历史记录数组
  // 结构通常包含: { id, title, poster, episodeIndex, progress, viewedAt }
  history: {
    type: Array,
    default: [],
  },
  // 收藏列表数组
  favorites: {
    type: Array,
    default: [],
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
})

// 导出模型
module.exports = mongoose.model("User", UserSchema)
