const fs = require("fs")
const path = require("path")
// 引入你的 Video 模型，根据截图路径调整
const Video = require("../models/Video")

// 爬虫 User-Agent 列表
const BOT_AGENTS = [
  "googlebot",
  "bingbot",
  "yandexbot",
  "baiduspider",
  "twitterbot",
  "facebookexternalhit",
  "rogerbot",
  "linkedinbot",
  "embedly",
  "quora link preview",
  "showyoubot",
  "outbrain",
  "pinterest",
  "slackbot",
  "vkShare",
  "W3C_Validator",
  "redditbot",
  "applebot",
  "whatsapp",
  "flipboard",
  "tumblr",
  "bitlybot",
  "discordbot",
]

// 预读取前端的 index.html 模板
// 注意：请根据你的实际目录结构调整这里的路径
// 假设 server.js 同级目录向上走一层，再进入 globalVision-web/dist
const FRONTEND_HTML_PATH = path.join(
  __dirname,
  "../../globalVision-web/dist/index.html",
)

let templateHtml = ""
try {
  if (fs.existsSync(FRONTEND_HTML_PATH)) {
    templateHtml = fs.readFileSync(FRONTEND_HTML_PATH, "utf8")
    console.log("✅ SEO: 前端模板加载成功")
  } else {
    console.warn("⚠️ SEO: 未找到前端 dist/index.html，请先编译前端项目")
  }
} catch (err) {
  console.error("SEO Template Error:", err)
}

const seoMiddleware = async (req, res, next) => {
  const userAgent = req.headers["user-agent"]?.toLowerCase() || ""

  // 1. 判断是否是静态资源 (js/css/img) -> 直接放行
  if (req.method !== "GET" || req.path.includes(".")) {
    return next()
  }

  // 2. 判断是否是爬虫
  const isBot = BOT_AGENTS.some((bot) => userAgent.includes(bot))

  // 如果不是爬虫，或者是首页等普通页面，直接下一步（交给 static 或 * 处理）
  // 这里我们只拦截详情页 /detail/xxxx
  if (!isBot || !req.path.startsWith("/detail/")) {
    return next()
  }

  try {
    // 3. 获取视频 ID
    // 假设路径是 /detail/12345
    const videoId = req.path.split("/").pop()

    if (!videoId) return next()

    // 4. 查询数据库 (使用你截图里的 Video 模型)
    // 根据你的数据库字段，这里可能是 findOne({ id: videoId }) 或者 findById(videoId)
    const video =
      (await Video.findOne({ id: videoId })) || (await Video.findById(videoId))

    if (!video) {
      return next() // 没查到数据，交给前端处理 404
    }

    // 5. 替换 HTML 内容
    // 假设你的 index.html 里默认 title 是 <title>极影聚合</title>
    // 我们用正则替换，确保万无一失
    let injectedHtml = templateHtml
      .replace(
        /<title>.*?<\/title>/,
        `<title>${video.title} - 高清在线观看 - 极影聚合</title>`,
      )
      .replace(
        /<meta name="description" content=".*?"\/?>/,
        `<meta name="description" content="在线观看《${video.title}》... ${video.content ? video.content.replace(/<[^>]+>/g, "").substring(0, 100) : ""}" />`,
      )

    // 6. 注入 Open Graph (社交分享卡片)
    const ogTags = `
      <meta property="og:title" content="${video.title} - 极影聚合" />
      <meta property="og:description" content="${video.content ? video.content.replace(/<[^>]+>/g, "").substring(0, 80) : ""}..." />
      <meta property="og:image" content="${video.poster}" />
      <meta property="og:type" content="video.movie" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:image" content="${video.poster}" />
    `

    injectedHtml = injectedHtml.replace("</head>", `${ogTags}</head>`)

    // 7. 直接返回处理过的 HTML 给爬虫
    res.send(injectedHtml)
    console.log(`🕷️ SEO: 已为爬虫渲染页面 [${video.title}]`)
  } catch (error) {
    console.error("SEO Middleware Error:", error)
    next() // 出错就降级处理，不影响访问
  }
}

module.exports = seoMiddleware
