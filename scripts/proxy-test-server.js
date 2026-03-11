require("dotenv").config()
const express = require("express")
const cors = require("cors")
const compression = require("compression")
const imageController = require("../controllers/imageController")
const videoProxyController = require("../controllers/videoProxyController")

const app = express()
app.set("trust proxy", 1)
app.use(compression())
app.use(
  cors({
    origin: "*",
    credentials: false,
    optionsSuccessStatus: 200,
  }),
)

app.get("/api/image/proxy", imageController.proxyImage)
app.get("/api/video/proxy/playlist", videoProxyController.proxyPlaylist)
app.get("/api/video/proxy/playlist.m3u8", videoProxyController.proxyPlaylist)
app.get("/api/video/proxy/segment", videoProxyController.proxySegment)

const port = Number(process.env.PORT || 3999)
app.listen(port, "0.0.0.0", () => {
  console.log(`proxy-test-server listening on ${port}`)
})

