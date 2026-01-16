const mongoose = require("mongoose")

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    console.error("❌ MONGO_URI is missing in .env")
    process.exit(1)
  }
  try {
    await mongoose.connect(process.env.MONGO_URI)
    console.log("✅ MongoDB Connected")
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err)
    process.exit(1)
  }
}

module.exports = connectDB
