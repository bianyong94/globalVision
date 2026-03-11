process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || "MOCK"

const axios = require("axios")
const Video = require("../models/Video")
const controller = require("../controllers/systemController")

const stubQuery = {
  sort() {
    return this
  },
  limit() {
    return this
  },
  select() {
    return this
  },
  lean() {
    return Promise.resolve([])
  },
}

Video.find = () => stubQuery

axios.get = async (url, config = {}) => {
  const u = String(url)
  if (u.includes("api.themoviedb.org/3/search/multi")) {
    return {
      data: {
        results: [
          {
            id: 101,
            media_type: "tv",
            name: "除恶",
            first_air_date: "2026-02-01",
            vote_average: 7.8,
            poster_path: "/tmdb-poster.jpg",
          },
        ],
      },
    }
  }
  if (u.includes("api.themoviedb.org/3/search/person")) {
    return { data: { results: [] } }
  }
  if (u.includes("api.themoviedb.org/3/discover/")) {
    return { data: { results: [] } }
  }

  if (u.includes("/api.php/provide/vod/")) {
    return {
      data: {
        list: [
          {
            vod_id: "999",
            vod_name: "除恶",
            vod_year: "2026",
            type_name: "电视剧",
            vod_area: "中国",
            vod_remarks: "更新至1集",
            vod_pic: "https://example.com/poster.jpg",
            vod_play_from: "ffm3u8",
            vod_play_url: "第1集$http://example.com/a.m3u8",
          },
        ],
      },
    }
  }

  if (String(config?.responseType || "") === "text" && u.includes(".m3u8")) {
    return {
      data: "#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080\nindex.m3u8\n",
    }
  }

  return { data: { results: [], list: [] } }
}

const run = async (question) => {
  const req = { body: { question } }
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(data) {
      this.payload = data
      return data
    },
  }
  await controller.askAI(req, res)
  console.log(JSON.stringify(res.payload, null, 2))
}

run("近期的热门新剧《除恶》")
