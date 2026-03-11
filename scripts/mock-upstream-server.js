const express = require("express")

const app = express()

const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5cH1QAAAAASUVORK5CYII="
const imgBuf = Buffer.from(png1x1, "base64")

app.get("/img.png", (req, res) => {
  res.setHeader("Content-Type", "image/png")
  res.setHeader("Cache-Control", "no-store")
  res.end(imgBuf)
})

app.get("/key.key", (req, res) => {
  res.setHeader("Content-Type", "application/octet-stream")
  res.end(Buffer.from("0123456789abcdef0123456789abcdef"))
})

app.get("/segment1.ts", (req, res) => {
  res.setHeader("Content-Type", "video/mp2t")
  res.end(Buffer.alloc(2048, 0x11))
})

app.get("/segment2.ts", (req, res) => {
  res.setHeader("Content-Type", "video/mp2t")
  res.end(Buffer.alloc(2048, 0x22))
})

app.get("/child.m3u8", (req, res) => {
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
  res.end(
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      '#EXT-X-MAP:URI="init.mp4"',
      "#EXTINF:10,",
      "segment1.ts",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"),
  )
})

app.get("/init.mp4", (req, res) => {
  res.setHeader("Content-Type", "video/mp4")
  res.end(Buffer.alloc(1024, 0x33))
})

app.get("/playlist.m3u8", (req, res) => {
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8")
  res.end(
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:10",
      '#EXT-X-KEY:METHOD=AES-128,URI="key.key"',
      "#EXTINF:10,",
      "segment1.ts",
      "#EXTINF:10,",
      "segment2.ts",
      "#EXTINF:10,",
      "child.m3u8",
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"),
  )
})

const port = Number(process.env.PORT || 4001)
app.listen(port, "0.0.0.0", () => {
  console.log(`mock-upstream-server listening on ${port}`)
})

