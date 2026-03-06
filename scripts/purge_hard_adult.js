require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video")
const { evaluateAdultContent } = require("../utils/adultContentFilter")

async function run() {
  const uri = process.env.MONGO_URI
  if (!uri) {
    console.error("❌ 缺少 MONGO_URI")
    process.exit(1)
  }
  await mongoose.connect(uri)

  const cursor = Video.find({})
    .select("_id title original_title tags overview latest_remarks sources area year")
    .lean()
    .cursor()

  const deleteIds = []
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    const title = `${doc.title || ""} ${doc.original_title || ""}`
    const tags = Array.isArray(doc.tags) ? doc.tags.join(" ") : ""
    const sourceText = Array.isArray(doc.sources)
      ? doc.sources.map((s) => `${s.vod_name || ""} ${s.remarks || ""}`).join(" ")
      : ""
    const item = {
      vod_name: title,
      vod_remarks: `${tags} ${doc.overview || ""} ${doc.latest_remarks || ""} ${sourceText}`,
      type_name: tags,
      vod_area: doc.area || "",
      vod_year: doc.year || "",
    }
    const judged = evaluateAdultContent(item, "")
    if (judged.blocked) deleteIds.push(doc._id)
  }

  console.log(`🧹 识别到硬色情候选: ${deleteIds.length}`)
  if (deleteIds.length > 0) {
    const result = await Video.deleteMany({ _id: { $in: deleteIds } })
    console.log(`✅ 已删除硬色情: ${result.deletedCount}`)
  } else {
    console.log("✅ 没有需要删除的硬色情内容")
  }
  await mongoose.disconnect()
}

run().catch(async (error) => {
  console.error("❌ 清理硬色情失败:", error.message)
  try {
    await mongoose.disconnect()
  } catch (_) {}
  process.exit(1)
})
