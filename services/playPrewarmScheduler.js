const cron = require("node-cron")
const { runPrewarmHotPlaylists } = require("../scripts/prewarmHotPlaylists")

let task = null

function startPlayPrewarmScheduler() {
  const enabled = String(process.env.PLAY_PREWARM_ENABLED || "true") === "true"
  if (!enabled) {
    console.log("[PlayPrewarm] 未启动: PLAY_PREWARM_ENABLED != true")
    return null
  }

  const expr = String(process.env.PLAY_PREWARM_CRON || "*/15 * * * *")
  const tz = String(process.env.TZ || "Asia/Shanghai")

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
        const r = await runPrewarmHotPlaylists()
        console.log(
          `[PlayPrewarm] 完成(cron) | warmed=${r.warmed || 0} failed=${r.failed || 0} considered=${r.considered || 0} costMs=${Date.now() - started}`,
        )
      } catch (e) {
        console.error("[PlayPrewarm] 失败(cron):", e?.message || e)
      }
    },
    { timezone: tz },
  )

  console.log(`[PlayPrewarm] 定时任务已启动: "${expr}" (${tz})`)
  return task
}

module.exports = { startPlayPrewarmScheduler }
