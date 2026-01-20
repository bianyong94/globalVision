require("dotenv").config()
const mongoose = require("mongoose")

const fixIndex = async () => {
  if (!process.env.MONGO_URI) return

  try {
    await mongoose.connect(process.env.MONGO_URI)
    console.log("✅ DB Connected")

    const collection = mongoose.connection.collection("videos")

    // 1. 先删除旧的 tmdb_id 索引
    try {
      console.log("🛠️ 正在删除旧索引...")
      await collection.dropIndex("tmdb_id_1")
      console.log("✅ 旧索引已删除")
    } catch (e) {
      console.log("⚠️ 索引可能不存在，跳过删除")
    }

    // 2. 建立新的稀疏索引 (Unique + Sparse)
    console.log("🛠️ 正在创建新的稀疏索引...")
    // sparse: true 允许某字段不存在，unique: true 保证存在的字段必须唯一
    await collection.createIndex(
      { tmdb_id: 1 },
      { unique: true, sparse: true, background: true }
    )

    console.log("✅ 索引修复完成！现在可以支持无数条无 ID 的数据了。")

    // 3. 清理一下之前遗留的 -1 数据 (可选)
    console.log("🧹 清理遗留的 -1 数据...")
    await collection.updateMany(
      { tmdb_id: -1 },
      { $unset: { tmdb_id: "" }, $set: { is_enriched: true } }
    )
    console.log("✅ 清理完成")
  } catch (err) {
    console.error("❌ Error:", err)
  } finally {
    process.exit(0)
  }
}

fixIndex()
