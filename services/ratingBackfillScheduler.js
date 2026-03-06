const cron = require("node-cron")
const Video = require("../models/Video")
const tmdbApi = require("./tmdb")

const SHORT_DRAMA_REGEX = /短剧|微短剧|爽剧|爽文|赘婿/i

const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const buildTypeIdByCategory = (category) => {
  if (category === "movie") return 1
  if (category === "tv") return 2
  if (category === "variety") return 3
  if (category === "anime") return 4
  return 0
}

let running = false
let scheduledTask = null

async function runRatingBackfillJob(trigger = "manual") {
  if (process.env.NODE_ENV !== "production") return
  if (running) return

  running = true
  const startedAt = Date.now()

  const limit = toInt(process.env.RATING_BACKFILL_BATCH, 40)
  const pauseMs = toInt(process.env.RATING_BACKFILL_ITEM_SLEEP_MS, 120)

  const query = {
    $and: [
      {
        $or: [
          { rating: { $exists: false } },
          { rating: { $lte: 0 } },
          { vote_count: { $exists: false } },
          { vote_count: { $lte: 0 } },
        ],
      },
      { title: { $exists: true, $ne: "" } },
      { title: { $not: SHORT_DRAMA_REGEX } },
      { category: { $in: ["movie", "tv", "anime", "variety"] } },
    ],
  }

  try {
    const rows = await Video.find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select("_id title year category rating vote_count date poster backdrop")

    if (rows.length === 0) {
      console.log(`[RatingBackfill] 跳过(${trigger}): 无需补全`)
      return
    }

    let updated = 0
    let failed = 0

    for (const video of rows) {
      try {
        const tmdb = await tmdbApi.search(
          video.title,
          video.year,
          buildTypeIdByCategory(video.category),
        )
        if (!tmdb?.id) {
          if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs))
          continue
        }

        const patch = {}
        const voteAverage = Number(tmdb.vote_average || 0)
        const voteCount = Number(tmdb.vote_count || 0)
        if (voteAverage > 0) patch.rating = voteAverage
        if (voteCount > 0) patch.vote_count = voteCount
        if (tmdb.id && !video.tmdb_id) patch.tmdb_id = tmdb.id

        const releaseDate = tmdb.release_date || tmdb.first_air_date || ""
        if (releaseDate && !video.date) patch.date = releaseDate

        const releaseYear = parseInt(String(releaseDate).slice(0, 4), 10)
        if (Number.isFinite(releaseYear) && !video.year) patch.year = releaseYear

        if (tmdb.poster_path && !video.poster) patch.poster = tmdb.poster_path
        if (tmdb.backdrop_path && !video.backdrop) patch.backdrop = tmdb.backdrop_path

        if (Object.keys(patch).length > 0) {
          await Video.updateOne({ _id: video._id }, { $set: patch })
          updated += 1
        }
      } catch (error) {
        failed += 1
      } finally {
        if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs))
      }
    }

    const costMs = Date.now() - startedAt
    console.log(
      `[RatingBackfill] 完成(${trigger}) | scanned=${rows.length} updated=${updated} failed=${failed} costMs=${costMs}`,
    )
  } finally {
    running = false
  }
}

function startRatingBackfillScheduler() {
  if (process.env.NODE_ENV !== "production") return
  if (String(process.env.RATING_BACKFILL_ENABLED || "true") !== "true") return
  if (scheduledTask) return

  const cronExpr = process.env.RATING_BACKFILL_CRON || "25 */6 * * *"
  const timezone = process.env.TZ || "Asia/Shanghai"
  scheduledTask = cron.schedule(
    cronExpr,
    () => {
      runRatingBackfillJob("cron").catch(() => {})
    },
    { timezone },
  )

  console.log(`[RatingBackfill] 定时任务已启动: "${cronExpr}" (${timezone})`)

  if (String(process.env.RATING_BACKFILL_RUN_ON_BOOT || "true") === "true") {
    const delay = toInt(process.env.RATING_BACKFILL_BOOT_DELAY_MS, 12000)
    setTimeout(() => {
      runRatingBackfillJob("boot").catch(() => {})
    }, delay)
  }
}

module.exports = {
  startRatingBackfillScheduler,
  runRatingBackfillJob,
}
