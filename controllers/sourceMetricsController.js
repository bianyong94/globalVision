const mongoose = require("mongoose")

exports.getSourceScores = async (req, res) => {
  try {
    const region = String(req.query.region || process.env.SOURCE_PROBE_REGION || "default")
    const coll = mongoose.connection.collection("source_speed_metrics")
    const rows = await coll
      .find(region ? { region } : {})
      .sort({ score: -1, updatedAt: -1 })
      .limit(50)
      .toArray()

    return res.json({ code: 200, data: rows })
  } catch (e) {
    return res.status(500).json({ code: 500, message: e?.message || "failed" })
  }
}
