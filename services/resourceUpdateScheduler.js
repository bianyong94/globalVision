const axios = require("axios")
const cron = require("node-cron")
const { sources, PRIORITY_LIST } = require("../config/sources")
const { getAxiosConfig } = require("../utils/httpAgent")
const { ingestVideo } = require("./ingestService")

const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const parseSourceKeys = () => {
  const configured = String(process.env.RESOURCE_SYNC_SOURCES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  const keys =
    configured.length > 0
      ? configured
      : PRIORITY_LIST || Object.keys(sources || {})
  return keys.filter((key) => Boolean(sources[key]))
}

let running = false
let scheduledTask = null

async function fetchListByPage(sourceConfig, hours, page) {
  const res = await axios.get(sourceConfig.url, {
    params: { ac: "detail", h: hours, pg: page },
    ...getAxiosConfig({
      timeout: toInt(process.env.RESOURCE_SYNC_TIMEOUT_MS, 9000),
    }),
  })

  return Array.isArray(res.data?.list) ? res.data.list : []
}

async function runForSource(sourceKey, options) {
  const sourceConfig = sources[sourceKey]
  if (!sourceConfig)
    return { scanned: 0, ingested: 0, skipped: 0, failed: 0, pages: 0 }

  const maxPages = options.maxPages
  const pageSleepMs = options.pageSleepMs
  const hours = options.hours

  let scanned = 0
  let ingested = 0
  let skipped = 0
  let failed = 0
  let pages = 0

  let consecutivePullErrors = 0
  for (let page = 1; page <= maxPages; page += 1) {
    let list = []
    try {
      list = await fetchListByPage(sourceConfig, hours, page)
      consecutivePullErrors = 0
    } catch (error) {
      console.error(
        `[ResourceSync] ${sourceKey} page=${page} 拉取失败: ${error.message}`,
      )
      failed += 1
      consecutivePullErrors += 1
      // 不中断整轮：跳过当前页继续采集；连续多页失败再停止
      if (consecutivePullErrors >= 5) {
        console.error(
          `[ResourceSync] ${sourceKey} 连续 ${consecutivePullErrors} 页拉取失败，提前停止该源`,
        )
        break
      }
      continue
    }

    if (list.length === 0) break

    pages += 1
    scanned += list.length

    const itemSleepMs = toInt(process.env.RESOURCE_SYNC_ITEM_SLEEP_MS, 0)
    for (const item of list) {
      if (!item?.vod_id || !item?.vod_name || !item?.vod_play_url) {
        failed += 1
        continue
      }

      try {
        const saved = await ingestVideo(item, sourceKey)
        if (saved) ingested += 1
        else skipped += 1
      } catch (error) {
        const msg = String(error?.message || "")
        if (/language override unsupported/i.test(msg)) {
          // 💡 修复逻辑：仅仅因为语言格式不对就跳过整部剧太亏了。
          // 这里强制清空有问题的语言字段，并进行二次入库尝试！
          console.warn(
            `[ResourceSync] 语言异常，正在清空语言并重试 vod_id=${item.vod_id}`,
          )
          item.vod_lang = "" // 清空引发崩溃的罪魁祸首字段

          try {
            const retrySaved = await ingestVideo(item, sourceKey)
            if (retrySaved) {
              ingested += 1 // 重试成功，算作正常入库
            } else {
              skipped += 1
            }
          } catch (retryError) {
            // 如果清空语言后依然报错，那只能无可奈何地跳过了
            skipped += 1
          }
        } else {
          // 其他非语言类的严重报错，正常计入 failed
          failed += 1
          console.error(
            `[ResourceSync] ${sourceKey} 入库失败 vod_id=${item.vod_id}: ${msg}`,
          )
        }
      }

      if (itemSleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, itemSleepMs))
      }
    }

    if (pageSleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pageSleepMs))
    }
  }

  return { scanned, ingested, skipped, failed, pages }
}

async function runResourceUpdateJob(trigger = "manual") {
  if (process.env.NODE_ENV !== "production") {
    console.log("[ResourceSync] 跳过: 非生产环境")
    return
  }

  if (running) {
    console.log("[ResourceSync] 跳过: 上一轮任务仍在执行")
    return
  }

  if (typeof ingestVideo !== "function") {
    console.error("[ResourceSync] 任务失败: ingestVideo 未实现")
    return
  }

  running = true
  const startedAt = Date.now()

  const options = {
    hours: toInt(process.env.RESOURCE_SYNC_HOURS, 6),
    maxPages: toInt(process.env.RESOURCE_SYNC_MAX_PAGES, 4),
    pageSleepMs: toInt(process.env.RESOURCE_SYNC_PAGE_SLEEP_MS, 80),
  }
  const sourceKeys = parseSourceKeys()

  let totalScanned = 0
  let totalIngested = 0
  let totalSkipped = 0
  let totalFailed = 0

  try {
    console.log(
      `[ResourceSync] 开始执行(${trigger}) | sources=${sourceKeys.join(",")} | hours=${options.hours} | maxPages=${options.maxPages}`,
    )

    for (const sourceKey of sourceKeys) {
      const stat = await runForSource(sourceKey, options)
      totalScanned += stat.scanned
      totalIngested += stat.ingested
      totalSkipped += stat.skipped
      totalFailed += stat.failed
      console.log(
        `[ResourceSync] ${sourceKey} 完成 | pages=${stat.pages} scanned=${stat.scanned} ingested=${stat.ingested} skipped=${stat.skipped} failed=${stat.failed}`,
      )
    }

    const ms = Date.now() - startedAt
    console.log(
      `[ResourceSync] 全部完成 | scanned=${totalScanned} ingested=${totalIngested} skipped=${totalSkipped} failed=${totalFailed} costMs=${ms}`,
    )
  } catch (error) {
    console.error(`[ResourceSync] 任务失败: ${error.message}`)
  } finally {
    running = false
  }
}

function startResourceUpdateScheduler() {
  if (process.env.NODE_ENV !== "production") {
    console.log("[ResourceSync] 未启动: 仅生产环境启用")
    return
  }

  if (String(process.env.RESOURCE_SYNC_ENABLED || "true") !== "true") {
    console.log("[ResourceSync] 未启动: RESOURCE_SYNC_ENABLED != true")
    return
  }

  if (scheduledTask) return

  const cronExpr = process.env.RESOURCE_SYNC_CRON || "10 */2 * * *"
  const timezone = process.env.TZ || "Asia/Shanghai"

  scheduledTask = cron.schedule(
    cronExpr,
    () => {
      runResourceUpdateJob("cron").catch((error) => {
        console.error(`[ResourceSync] cron 执行异常: ${error.message}`)
      })
    },
    { timezone },
  )

  console.log(`[ResourceSync] 定时任务已启动: "${cronExpr}" (${timezone})`)

  if (String(process.env.RESOURCE_SYNC_RUN_ON_BOOT || "true") === "true") {
    const delay = toInt(process.env.RESOURCE_SYNC_BOOT_DELAY_MS, 5000)
    setTimeout(() => {
      runResourceUpdateJob("boot").catch((error) => {
        console.error(`[ResourceSync] boot 执行异常: ${error.message}`)
      })
    }, delay)
  }
}

module.exports = {
  startResourceUpdateScheduler,
  runResourceUpdateJob,
}
