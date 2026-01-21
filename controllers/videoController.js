const Video = require("../models/Video")
const { getCache, setCache } = require("../utils/cache")
const {
  smartFetch,
  saveToDB,
  getAxiosConfig,
} = require("../services/videoService")
const { sources } = require("../config/constants")
const axios = require("axios")
const mongoose = require("mongoose")

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

// 辅助函数：统一返回格式
const formatDetail = (video) => {
  // 如果是聚合模型，sources 是数组
  // 我们需要确保返回给前端的结构是完整的
  return {
    id: video._id, // 核心 ID
    title: video.title,
    poster: video.poster,
    category: video.category,
    year: video.year,
    area: video.area,
    rating: video.rating,
    content: video.overview || video.content,
    actors: video.actors,
    director: video.director,
    tags: video.tags || [],

    // 🔥 核心：直接返回聚合后的 sources 数组
    // 如果没有 sources 数组（旧数据），则尝试构造一个兼容的
    sources:
      video.sources && video.sources.length > 0
        ? video.sources
        : [
            {
              source_key: video.source || "unknown",
              source_name: sources[video.source]?.name || "默认源",
              vod_play_url: video.vod_play_url,
              remarks: video.remarks,
            },
          ],
  }
}

exports.getVideos = async (req, res) => {
  try {
    const { cat, tag, area, year, sort, pg = 1, wd } = req.query
    const limit = 20
    const skip = (parseInt(pg) - 1) * limit

    // ==========================================
    // 1. 构建筛选条件 ($match)
    // ==========================================
    const matchStage = {}

    // 🔍 关键词搜索
    if (wd) {
      const regex = new RegExp(wd, "i")
      matchStage.$or = [
        { title: regex },
        { actors: regex },
        { director: regex },
      ]
    }

    // 📂 分类筛选
    if (cat && cat !== "all") {
      matchStage.category = cat
    }

    // 🌍 地区筛选
    if (area) {
      matchStage.area = new RegExp(area)
    }

    // 📅 年份筛选
    if (year && year !== "全部") {
      matchStage.year = parseInt(year)
    }

    // ==========================================
    // 2. 标签与特殊模式逻辑
    // ==========================================
    if (tag) {
      const lowerTag = tag.toLowerCase()

      if (lowerTag === "high_score") {
        // 🏆 高分榜单模式 (严格)
        // 1. 评分必须 >= 7.5
        matchStage.rating = { $gte: 7.5 }
        // 2. 必须有一定评分人数 (防止只有1人评10分的片子)
        matchStage.vote_count = { $gte: 20 }
        // 3. 必须是清洗过的数据
        matchStage.tmdb_id = { $exists: true }
      } else if (lowerTag === "netflix") {
        // 🎬 Netflix 模式 (忽略大小写)
        matchStage.tags = { $in: ["Netflix", "netflix", "NETFLIX"] }
      } else if (["4k", "2160p"].includes(lowerTag)) {
        // 💎 4K 模式
        matchStage.tags = { $in: ["4K", "4k", "2160P"] }
      } else {
        // 🏷️ 普通标签 (通用正则匹配，忽略大小写)
        matchStage.tags = { $regex: new RegExp(`^${tag}$`, "i") }
      }
    }

    // ==========================================
    // 3. 构建排序逻辑 ($sort)
    // ==========================================
    let sortStage = {}

    // 优先处理明确的排序指令
    if (sort === "rating" || (tag && tag.toLowerCase() === "high_score")) {
      // ⭐ 按评分排序
      sortStage = { rating: -1, year: -1, updatedAt: -1 }

      // 🛡️ 兜底：如果用户没选 high_score 标签，只是点了排序按钮
      // 我们也要过滤掉 0 分的数据，否则排序会很乱
      if (!matchStage.rating) {
        matchStage.rating = { $gt: 0 }
      }
      // 建议：即使是手动排序，也最好过滤掉极少人评分的
      if (!matchStage.vote_count) {
        matchStage.vote_count = { $gt: 0 } // 至少有人评过分
      }
    } else if (sort === "year") {
      // 📅 按年份排序
      sortStage = { year: -1, updatedAt: -1 }
    } else {
      // 🕒 默认：按更新时间 (最新入库/更新的在前面)
      sortStage = { updatedAt: -1 }
    }

    // ==========================================
    // 4. 执行聚合查询 (Aggregation)
    // ==========================================
    const pipeline = [
      { $match: matchStage }, // 1. 筛选
      { $sort: sortStage }, // 2. 排序
      { $skip: skip }, // 3. 跳页
      { $limit: limit }, // 4. 限制数量
      {
        $project: {
          // 5. 输出字段控制 (只取需要的，减少传输量)
          _id: 1, // 必须取 _id，后面才能转换
          title: 1,
          poster: 1,
          rating: 1,
          year: 1,
          remarks: 1,
          tags: 1,
          category: 1,
          updatedAt: 1,
          // 如果需要判断来源，可取 sources
          // sources: 1
        },
      },
    ]

    const list = await Video.aggregate(pipeline)

    // ==========================================
    // 5. 数据格式化 (清洗返回给前端的数据)
    // ==========================================
    const formattedList = list.map((item) => ({
      ...item,
      // 🆔 ID 映射：把 MongoDB 的 _id 对象转为字符串 id
      id: item._id.toString(),
      // 🧹 移除 _id 防止前端混淆 (可选)
      _id: undefined,

      // ⭐ 评分格式化：保留1位小数 (7.56 -> 7.6, 8 -> 8.0由前端处理或保持8)
      rating: item.rating ? parseFloat(item.rating.toFixed(1)) : 0,

      // 📅 年份防呆：如果是 2026 这种未来年份，如果不希望显示，可以在这里处理
      // year: item.year > new Date().getFullYear() + 1 ? 0 : item.year
    }))

    // ==========================================
    // 6. 返回结果
    // ==========================================
    res.json({ code: 200, list: formattedList })
  } catch (e) {
    console.error("Search API Error:", e)
    res.status(500).json({ code: 500, msg: "Error" })
  }
}

exports.getHome = async (req, res) => {
  try {
    const fixId = (queryResult) =>
      queryResult.map((item) => {
        // item 可能是 mongoose document，需要转成普通对象
        const doc = item._doc || item
        return {
          ...doc,
          // ✅ 核心：把 uniq_id 赋值给 id
          id: doc.uniq_id || doc.id || doc._id,
        }
      })
    // 并行查询，速度极快
    const [banners, netflix, shortDrama, highRateTv, newMovies] =
      await Promise.all([
        // 轮播图：取最近更新的 4K 电影或 Netflix 剧集
        Video.find({
          category: "movie",
          $or: [{ tags: "4k" }, { year: new Date().getFullYear() }],
        })
          .sort({ updatedAt: -1 }) // 按更新时间排
          .limit(5)
          .select("title poster tags remarks uniq_id id"),

        // 2. Netflix 栏目 -> 改为 "精选欧美剧" (如果没有 netflix 标签，就查欧美分类)
        Video.find({ tags: "netflix" })
          .sort({ rating: -1, updatedAt: -1 })
          .limit(10)
          .select("title poster remarks uniq_id id"),

        // Section 2: 热门短剧 (专门筛选 miniseries 标签)
        Video.find({ tags: "miniseries" })
          .sort({ updatedAt: -1 })
          .limit(10)
          .select("title poster remarks uniq_id"),

        // Section 3: 高分美剧 (分类+标签+评分排序)
        Video.find({
          category: "tv",
          // 只要标签里沾边的都算，增加命中率
          tags: {
            $in: ["欧美", "美剧", "netflix", "hbo", "apple_tv", "disney"],
          },
          // rating: { $gt: 0 } // 暂时只要求有分就行，先别要求太高，看有没有数据
        })
          .sort({ rating: -1 })
          .limit(10)
          .select("title poster rating uniq_id"),

        // Section 4: 院线新片
        // 5. 院线新片 -> 只要是电影且年份是今年或去年
        Video.find({
          category: "movie",
          year: { $gte: new Date().getFullYear() - 1 },
        })
          .sort({ updatedAt: -1 })
          .limit(12)
          .select("title poster remarks uniq_id id"),
      ])

    res.json({
      code: 200,
      data: {
        banners: fixId(banners),
        sections: [
          { title: "Netflix 精选", type: "scroll", data: fixId(netflix) },
          { title: "爆火短剧", type: "grid", data: fixId(shortDrama) },
          { title: "口碑美剧", type: "grid", data: fixId(highRateTv) },
          { title: "院线新片", type: "grid", data: fixId(newMovies) },
        ],
      },
    })
  } catch (e) {
    res.status(500).json({ code: 500, msg: e.message })
  }
}

exports.getDetail = async (req, res) => {
  const { id } = req.params // 可能是 "65a4f..." (_id) 或 "maotai_123" (旧ID)

  // 1. 缓存检查 (缓存 10 分钟)
  const cacheKey = `detail_v5_${id}`
  const cachedData = await getCache(cacheKey)

  // 辅助函数：标准化返回
  const success = (res, data) =>
    res.json({ code: 200, message: "success", data })
  const fail = (res, msg = "Error", code = 500) =>
    res.json({ code, message: msg })

  if (cachedData) return success(res, cachedData)

  try {
    let video = null

    // ==========================================
    // 步骤 A: 优先尝试 MongoDB _id 查询 (新架构标准)
    // ==========================================
    // 只有当 id 是 24位 hex 字符串时才尝试，避免报错
    if (mongoose.Types.ObjectId.isValid(id)) {
      video = await Video.findById(id)
    }

    // ==========================================
    // 步骤 B: 如果没找到，尝试兼容旧 ID 查询
    // ==========================================
    if (!video) {
      // 旧逻辑：可能是 "maotai_12345" 这种格式
      // 或者在 sources 数组里查找子文档的 vod_id
      video = await Video.findOne({
        $or: [
          { uniq_id: id }, // 匹配旧版 Flat 数据
          { "sources.vod_id": id }, // 匹配聚合后的子资源 ID
          { custom_id: id }, // 匹配自定义 ID (如果有)
        ],
      })
    }

    // ==========================================
    // 步骤 C: 还是没找到？ -> 404
    // ==========================================
    // ⚠️ 我们已经移除了“回源采集”逻辑，因为：
    // 1. 你现在是全量采集模式，数据库理应有数据。
    // 2. 拿 MongoDB ID 去请求资源站接口会导致 crash。
    // 3. 避免了恶意用户乱输 ID 导致服务器卡顿。
    if (!video) {
      console.warn(`⚠️ [Detail] Not Found: ${id}`)
      return fail(res, "资源未找到或已下架", 404)
    }

    // ==========================================
    // 步骤 D: 格式化数据并返回
    // ==========================================
    const result = formatDetail(video)

    // 写入缓存
    await setCache(cacheKey, result, 600)

    success(res, result)
  } catch (e) {
    console.error(`🔥 [Detail] Error processing ID: ${id}`, e)
    fail(res, "服务器内部错误: " + e.message)
  }
}

exports.searchSources = async (req, res) => {
  const { title } = req.query

  if (!title) return fail(res, "缺少标题参数", 400)

  // 1. 缓存检查 (防止短时间重复搜同一个词炸接口)
  const cacheKey = `sources_search_${encodeURIComponent(title)}`
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    // 2. 获取所有配置的源 keys
    const allSourceKeys = Object.keys(sources)

    // 3. 并发请求所有源
    // 使用 Promise.allSettled 也可以，这里用 map + catch 保证一个挂了不影响其他
    const searchPromises = allSourceKeys.map(async (key) => {
      const sourceConfig = sources[key]
      try {
        // 请求资源站: ac=detail 才能拿到播放地址
        const response = await axios.get(sourceConfig.url, {
          params: { ac: "detail", wd: title },
          timeout: 6000, // 6秒超时，太慢的源就不要了
          ...getAxiosConfig(),
        })

        const list = response.data?.list || []

        // 4. 过滤与匹配逻辑
        // 资源站搜索是模糊的，我们需要过滤掉不相关的
        const validItems = list.filter((item) => {
          // 简单包含关系，忽略大小写
          return item.vod_name.toLowerCase().includes(title.toLowerCase())
        })

        // 5. 格式化返回数据
        return validItems.map((item) => ({
          // 构造临时 ID (格式: feifan_12345)
          id: `${key}_${item.vod_id}`,
          source_key: key,
          source_name: sourceConfig.name, // 显示 "非凡资源"

          // 🔥 关键：返回具体标题，方便用户区分是 "第一季" 还是 "第二季"
          title: item.vod_name,

          // 🔥 关键：返回播放地址，前端点击即播，无需再查
          vod_play_url: item.vod_play_url,
          remarks: item.vod_remarks,

          // 标记类型
          type: "external",
        }))
      } catch (err) {
        // console.warn(`源 ${sourceConfig.name} 搜索超时或失败`);
        return [] // 失败返回空数组，不影响整体
      }
    })

    const results = await Promise.all(searchPromises)

    // 5. 拍平数组 (因为 map 返回的是 array of arrays)
    const availableSources = results.flat()

    if (availableSources.length === 0) {
      return success(res, [])
    }

    // 6. 存入缓存
    await setCache(cacheKey, availableSources, 600)

    success(res, availableSources)
  } catch (e) {
    console.error("Search Sources Error:", e)
    fail(res, "搜索源失败")
  }
}

exports.matchResource = async (req, res) => {
  // 1. 接收参数
  const { tmdb_id, category, title, year } = req.query

  // 辅助函数
  const success = (res, data) =>
    res.json({ code: 200, message: "success", data })
  const fail = (res, msg = "Error", code = 500) =>
    res.json({ code, message: msg })

  if (!tmdb_id && !title) {
    return fail(res, "缺少匹配参数", 400)
  }

  try {
    let video = null

    // ==========================================
    // 🎯 策略 A: TMDB ID 精准匹配 (最优先)
    // ==========================================
    if (tmdb_id) {
      const tmdbIdNum = parseInt(tmdb_id)
      if (!isNaN(tmdbIdNum)) {
        video = await Video.findOne({ tmdb_id: tmdbIdNum })
      }
      if (!video) {
        video = await Video.findOne({ tmdb_id: tmdb_id })
      }
    }

    // ==========================================
    // 🔎 策略 B: 标题 + 年份 + 分类 兜底匹配
    // ==========================================
    if (!video && title) {
      console.log(`[Match] 尝试标题匹配: ${title} (${year || "无年份"})`)

      const query = { title: title }

      // 🔒 1. 强分类校验
      if (category && category !== "all") {
        query.category = category
      }

      // 🔒 2. 年份模糊校验 (误差容忍 ±1年)
      if (year) {
        const y = parseInt(year)
        if (!isNaN(y)) {
          query.year = { $gte: y - 1, $lte: y + 1 }
        }
      }

      // 🔒 3. 原始分类黑名单过滤
      query.original_type = { $not: /短剧|爽文|爽剧|反转|赘婿|战神|重生/ }

      // 执行查询，取最新的一个
      video = await Video.findOne(query).sort({ updatedAt: -1 })

      // 🔥 4. 二次逻辑校验
      if (video) {
        // 检查是否为伪装成电影的短剧
        const checkUrl =
          video.sources?.[0]?.vod_play_url || video.vod_play_url || ""
        const episodeCount = checkUrl ? checkUrl.split("#").length : 0

        if (
          (category === "movie" || video.category === "movie") &&
          episodeCount > 5
        ) {
          console.log(`[Match] 拦截疑似短剧: ${video.title}`)
          video = null
        }
      }
    }

    // ==========================================
    // 🚀 结果提取
    // ==========================================
    if (video) {
      // 获取集数 (适配聚合模型 sources 数组)
      let finalEpisodeCount = 0
      let finalPlayFrom = "unknown"

      if (video.sources && video.sources.length > 0) {
        // 取第一个可用源
        const firstSource = video.sources[0]
        finalPlayFrom = firstSource.source_key
        finalEpisodeCount = firstSource.vod_play_url
          ? firstSource.vod_play_url.split("#").length
          : 0
      } else if (video.vod_play_url) {
        // 兼容旧数据
        finalPlayFrom = video.source || "unknown"
        finalEpisodeCount = video.vod_play_url.split("#").length
      }

      // 只有当确实有播放链接时才返回
      if (finalEpisodeCount > 0) {
        return success(res, {
          found: true,
          // 🔥 关键：返回 MongoDB _id，供前端跳转详情页
          id: video._id.toString(),
          title: video.title,
          source: finalPlayFrom,
          episodes_count: finalEpisodeCount,
          year: video.year,
        })
      }
    }

    // 没找到
    return success(res, {
      found: false,
      message: "本地库暂未收录该资源",
    })
  } catch (e) {
    console.error("Match Error:", e)
    return fail(res, "匹配过程发生异常: " + e.message)
  }
}
