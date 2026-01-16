require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video") // 确保路径正确
const { syncTask } = require("./sync") // 假设你之前的采集任务叫 sync.js
// 如果你还没有 sync.js，请看文章末尾的补充

const resetAndSync = async () => {
  console.log("🧨 [系统] 准备连接数据库...")

  if (!process.env.MONGO_URI) {
    console.error("❌ 未配置 MONGO_URI")
    return
  }

  try {
    await mongoose.connect(process.env.MONGO_URI)
    console.log("✅ MongoDB 连接成功")

    // 1. 🔥 清空数据 (只清空视频，保留用户数据)
    console.log("🗑️ [操作] 正在清空 'cpmass' 数据库中的视频数据...")
    const deleteResult = await Video.deleteMany({})
    console.log(`✅ 已删除 ${deleteResult.deletedCount} 条旧视频数据`)

    // 2. 🚀 触发采集
    // 这里的 24 代表采集最近 24 小时的数据，或者你可以改为更长时间，或者全量采集
    console.log("🚀 [操作] 开始全量采集任务...")

    // 假设 syncTask 接受一个参数(小时数)，如果是全量采集，你可能需要修改 syncTask 逻辑
    // 这里我们先采集最近 120 小时（5天）的数据作为初始化
    await syncTask(120)

    console.log("✨ [完成] 初始化任务结束")
  } catch (err) {
    console.error("❌ 任务出错:", err)
  }
}

// 如果直接运行此脚本则执行，如果被引用则导出
if (require.main === module) {
  resetAndSync().then(() => {
    mongoose.disconnect()
    process.exit(0)
  })
}

module.exports = { resetAndSync }
