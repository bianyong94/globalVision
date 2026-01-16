const axios = require("axios")
const { HttpsProxyAgent } = require("https-proxy-agent")
const proxyUrl = process.env.PROXY_URL
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

const tmdbApi = axios.create({
  baseURL: "https://api.themoviedb.org/3",
  headers: { Authorization: `Bearer ${process.env.TMDB_TOKEN}` },
  params: { language: "zh-CN" },
  httpsAgent: process.env.NODE_ENV === "development" ? agent : null,
  proxy: false,
})

exports.getNetflix = async (req, res) => {
  try {
    const response = await tmdbApi.get("/discover/tv", {
      params: {
        with_watch_providers: 8, // Netflix ID
        watch_region: "US", // 或者 TW
        sort_by: "popularity.desc",
        "vote_count.gte": 100, // 过滤太冷门的
      },
    })

    // 格式化一下返回给前端
    const list = response.data.results.map((item) => ({
      tmdb_id: item.id,
      title: item.name, // 剧集叫 name
      poster: `https://image.tmdb.org/t/p/w500${item.poster_path}`,
      backdrop: `https://image.tmdb.org/t/p/w780${item.backdrop_path}`,
      rating: item.vote_average,
      year: parseInt((item.first_air_date || "").substring(0, 4)),
      overview: item.overview,
      category: "tv", // 明确这是剧集
    }))

    success(res, list)
  } catch (e) {
    console.error("Netflix API Error:", e.message)
    fail(res, "无法获取 Netflix 榜单")
  }
}
exports.getTopRated = async (req, res) => {
  try {
    const response = await tmdbApi.get("/discover/movie", {
      params: {
        sort_by: "vote_average.desc",
        "vote_count.gte": 1000, // 必须超过1000人评分，防止小众刷分
        "vote_average.gte": 8.0, // 8分以上
      },
    })

    const list = response.data.results.map((item) => ({
      tmdb_id: item.id,
      title: item.title, // 电影叫 title
      poster: `https://image.tmdb.org/t/p/w500${item.poster_path}`,
      backdrop: `https://image.tmdb.org/t/p/w780${item.backdrop_path}`,
      rating: item.vote_average,
      year: parseInt((item.release_date || "").substring(0, 4)),
      overview: item.overview,
      category: "movie",
    }))

    success(res, list)
  } catch (e) {
    fail(res, "无法获取高分榜单")
  }
}
