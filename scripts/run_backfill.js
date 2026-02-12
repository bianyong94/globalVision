// scripts/run_backfill.js
require("dotenv").config()
const mongoose = require("mongoose")
const { runFastBackfill } = require("../services/syncService")

async function main() {
  try {
    await mongoose.connect(process.env.MONGODB_URI)
    console.log("✅ DB Connected. Starting backfill...")

    // 执行极速补全
    await runFastBackfill()

    console.log("👋 任务结束，程序退出")
    process.exit(0)
  } catch (e) {
    console.error("❌ Error:", e)
    process.exit(1)
  }
}

main()
