const cron = require("node-cron")
const { runTrendingIngestJob } = require("../scripts/trendingIngest")

let task = null

function startTrendingIngestScheduler() {
  const enabled = String(process.env.TRENDING_INGEST_ENABLED || "true") === "true"
  if (!enabled) {
    console.log("[TrendingIngest] 未启动: TRENDING_INGEST_ENABLED != true")
    return null
  }

  const expr = String(process.env.TRENDING_INGEST_CRON || "35 */4 * * *")
  const timezone = String(process.env.TZ || "Asia/Shanghai")

  if (task) {
    try {
      task.stop()
      task.destroy()
    } catch (e) {}
  }

  task = cron.schedule(
    expr,
    async () => {
      const started = Date.now()
      try {
        const result = await runTrendingIngestJob("cron")
        console.log(
          `[TrendingIngest] 完成(cron) | total=${result.total} ingested=${result.ingested} skipped=${result.skipped} failed=${result.failed} costMs=${Date.now() - started}`,
        )
      } catch (e) {
        console.error("[TrendingIngest] 失败(cron):", e?.message || e)
      }
    },
    { timezone },
  )

  console.log(`[TrendingIngest] 定时任务已启动: "${expr}" (${timezone})`)
  return task
}

module.exports = { startTrendingIngestScheduler }
