require("dotenv").config()
const mongoose = require("mongoose")
const Video = require("../models/Video")
const { scoreShortDrama } = require("../utils/shortDramaFilter")

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

  const toDeleteIds = []
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    const title = `${doc.title || ""} ${doc.original_title || ""}`
    const tags = Array.isArray(doc.tags) ? doc.tags.join(" ") : ""
    const overview = `${doc.overview || ""} ${doc.latest_remarks || ""}`
    const sourceNames = Array.isArray(doc.sources)
      ? doc.sources.map((s) => `${s.vod_name || ""} ${s.remarks || ""}`).join(" ")
      : ""

    const mock = {
      vod_name: title,
      vod_remarks: `${tags} ${overview} ${sourceNames}`,
      vod_area: doc.area || "",
      vod_year: doc.year || "",
      vod_play_url: Array.isArray(doc.sources) ? doc.sources[0]?.vod_play_url || "" : "",
    }
    const judged = scoreShortDrama(mock, "")
    if (judged.blocked) {
      toDeleteIds.push(doc._id)
    }
  }

  console.log(`🧹 识别到短剧候选: ${toDeleteIds.length}`)
  if (toDeleteIds.length > 0) {
    const result = await Video.deleteMany({ _id: { $in: toDeleteIds } })
    console.log(`✅ 已删除短剧: ${result.deletedCount}`)
  } else {
    console.log("✅ 没有需要删除的短剧")
  }

  await mongoose.disconnect()
}

run().catch(async (error) => {
  console.error("❌ 短剧清理失败:", error.message)
  try {
    await mongoose.disconnect()
  } catch (_) {}
  process.exit(1)
})
