const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { spawn } = require("child_process")

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "/opt/global-vision/downloads"
const MAX_TASKS = Number.parseInt(process.env.DOWNLOAD_MAX_TASKS || "200", 10)
const MAX_SECONDS = Number.parseInt(process.env.DOWNLOAD_MAX_SECONDS || "3600", 10)
const MIN_READY_BYTES = Number.parseInt(process.env.DOWNLOAD_MIN_READY_BYTES || "5242880", 10)

const tasks = new Map()

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const safeName = (name = "") =>
  String(name || "video")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)

const buildTask = ({ url, title = "video", episode = "" }) => {
  const id = crypto.randomUUID().replace(/-/g, "")
  const base = safeName(`${title}${episode ? `-${episode}` : ""}`) || "video"
  const fileName = `${base}-${id.slice(0, 6)}.mp4`
  const outPath = path.join(DOWNLOAD_DIR, fileName)
  const now = Date.now()
  return {
    id,
    url,
    title,
    episode,
    fileName,
    outPath,
    status: "queued",
    progress: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    error: "",
    pid: null,
  }
}

const runTask = (task) => {
  task.status = "running"
  task.startedAt = Date.now()

  const args = [
    "-y",
    "-loglevel",
    "warning",
    "-rw_timeout",
    "15000000",
    "-i",
    task.url,
    "-t",
    String(MAX_SECONDS),
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-movflags",
    "+faststart",
    task.outPath,
  ]

  const child = spawn("ffmpeg", args)
  task.pid = child.pid

  child.stderr.on("data", (buf) => {
    const line = String(buf || "")
    if (line.includes("time=")) {
      // 简易活跃度进度：有时间线输出就认为正在推进
      task.progress = Math.min(99, Math.max(3, task.progress + 1))
    }
  })

  child.on("error", (err) => {
    task.status = "failed"
    task.error = err?.message || "ffmpeg start failed"
    task.finishedAt = Date.now()
  })

  child.on("close", (code) => {
    task.pid = null
    let size = 0
    try {
      size = fs.statSync(task.outPath).size || 0
    } catch (e) {}

    if (code === 0 && size > 0) {
      task.status = "done"
      task.progress = 100
      task.finishedAt = Date.now()
      return
    }

    // 某些源会非0退出但文件已可用，允许直接就绪
    if (size >= MIN_READY_BYTES) {
      task.status = "done"
      task.progress = 100
      task.error = `ffmpeg exit ${code}, file kept`
      task.finishedAt = Date.now()
      return
    }

    task.status = "failed"
    task.error = `ffmpeg exit code ${code}`
    task.finishedAt = Date.now()
  })
}

exports.createTask = async (req, res) => {
  try {
    ensureDir(DOWNLOAD_DIR)
    const url = String(req.body?.url || "").trim()
    const title = String(req.body?.title || "video").trim()
    const episode = String(req.body?.episode || "").trim()

    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ code: 400, message: "invalid url" })
    }

    if (tasks.size >= MAX_TASKS) {
      const doneIds = [...tasks.values()]
        .filter((t) => t.status === "done" || t.status === "failed")
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, 20)
        .map((t) => t.id)
      doneIds.forEach((id) => tasks.delete(id))
    }

    const task = buildTask({ url, title, episode })
    tasks.set(task.id, task)
    runTask(task)

    return res.json({
      code: 200,
      data: {
        id: task.id,
        status: task.status,
        progress: task.progress,
        fileName: task.fileName,
        directUrl: `/api/v2/download/file/${task.id}`,
      },
    })
  } catch (e) {
    return res.status(500).json({ code: 500, message: e?.message || "create failed" })
  }
}

exports.getTask = async (req, res) => {
  const id = String(req.params?.id || "")
  const t = tasks.get(id)
  if (!t) return res.status(404).json({ code: 404, message: "task not found" })

  return res.json({
    code: 200,
    data: {
      id: t.id,
      status: t.status,
      progress: t.progress,
      title: t.title,
      episode: t.episode,
      fileName: t.fileName,
      error: t.error,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      downloadUrl: t.status === "done" ? `/api/v2/download/file/${t.id}` : "",
    },
  })
}

exports.listTasks = async (_req, res) => {
  const rows = [...tasks.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
    .map((t) => ({
      id: t.id,
      status: t.status,
      progress: t.progress,
      title: t.title,
      episode: t.episode,
      fileName: t.fileName,
      error: t.error,
      createdAt: t.createdAt,
      downloadUrl: t.status === "done" ? `/api/v2/download/file/${t.id}` : "",
    }))
  return res.json({ code: 200, data: rows })
}

exports.downloadFile = async (req, res) => {
  const id = String(req.params?.id || "")
  const t = tasks.get(id)
  if (!t) return res.status(404).json({ code: 404, message: "task not found" })
  if (t.status !== "done" || !fs.existsSync(t.outPath)) {
    return res.status(409).json({ code: 409, message: "file not ready" })
  }
  try {
    const st = fs.statSync(t.outPath)
    if (st?.size > 0) res.setHeader("Content-Length", String(st.size))
  } catch (e) {}
  return res.download(t.outPath, t.fileName)
}

exports.downloadDirect = async (req, res) => {
  const url = String(req.query?.url || "").trim()
  const title = safeName(String(req.query?.title || "video")) || "video"
  const episode = safeName(String(req.query?.episode || ""))

  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ code: 400, message: "invalid url" })
  }

  const fileName = `${title}${episode ? `-${episode}` : ""}.mp4`

  res.setHeader("Content-Type", "video/mp4")
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  )
  res.setHeader("Cache-Control", "no-store")
  if (typeof res.flushHeaders === "function") res.flushHeaders()

  const args = [
    "-loglevel",
    "error",
    "-rw_timeout",
    "15000000",
    "-i",
    url,
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-movflags",
    "frag_keyframe+empty_moov",
    "-f",
    "mp4",
    "pipe:1",
  ]

  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })

  const kill = () => {
    try {
      ff.kill("SIGKILL")
    } catch (e) {}
  }
  req.on("close", kill)

  ff.stderr.on("data", () => {})
  ff.stdout.pipe(res)

  ff.on("close", (code) => {
    req.off("close", kill)
    if (code !== 0 && !res.headersSent) {
      res.status(502).json({ code: 502, message: "direct download failed" })
    }
  })
}
