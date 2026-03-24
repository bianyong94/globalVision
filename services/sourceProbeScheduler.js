const cron = require("node-cron")
const { runSourceProbe } = require("../scripts/probeSourceSpeed")

let task = null

function startSourceProbeScheduler() {
  const enabled = String(process.env.SOURCE_PROBE_ENABLED || "true") === "true"
  if (!enabled) {
    console.log("[SourceProbe] 未启动: SOURCE_PROBE_ENABLED != true")
    return null
  }

  const expr = String(process.env.SOURCE_PROBE_CRON || "45 */2 * * *")
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
        const r = await runSourceProbe()
        console.log(
          `[SourceProbe] 完成(cron) | region=${r.region} count=${r.count} costMs=${Date.now() - started}`,
        )
      } catch (e) {
        console.error("[SourceProbe] 失败(cron):", e?.message || e)
      }
    },
    { timezone: tz },
  )

  console.log(`[SourceProbe] 定时任务已启动: "${expr}" (${tz})`)
  return task
}

module.exports = { startSourceProbeScheduler }
