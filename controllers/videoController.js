const Video = require("../models/Video")
const { getCache, setCache } = require("../utils/cache")
const { getAxiosConfig } = require("../utils/httpAgent")
// 👇 1. 引入优先级配置
const { sources, PRIORITY_LIST } = require("../config/sources")
const axios = require("axios")
const mongoose = require("mongoose")

const escapeRegex = (string) => {
  return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
}

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

// 辅助函数：统一返回格式
const formatDetail = (video) => {
  // 👇 2. 新增排序逻辑
  let finalSources = video.sources || []
  if (finalSources.length > 1) {
    finalSources.sort((a, b) => {
      // 获取源在优先级列表中的位置 (找不到返回 -1)
      let indexA = PRIORITY_LIST.indexOf(a.source_key)
      let indexB = PRIORITY_LIST.indexOf(b.source_key)

      // 如果配置里没写的源，放到最后面 (给 999 权重)
      if (indexA === -1) indexA = 999
      if (indexB === -1) indexB = 999

      return indexA - indexB // 升序排列，index 越小越靠前
    })
  }

  // 如果 sources 为空（旧数据），构造默认源
  if (finalSources.length === 0 && video.vod_play_url) {
    finalSources = [
      {
        source_key: video.source || "unknown",
        source_name: sources[video.source]?.name || "默认源",
        vod_play_url: video.vod_play_url,
        remarks: video.remarks,
      },
    ]
  }
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

    sources: finalSources,
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
      const safeWd = escapeRegex(wd) // ✅ 安全
      const regex = new RegExp(safeWd, "i")
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
      const targetYear = parseInt(year)
      if (!isNaN(targetYear)) {
        // 兼容数字和字符串两种存储情况
        matchStage.$or = [{ year: targetYear }, { year: String(targetYear) }]
        // 如果你的数据库year字段确定全是数字，则保留原样即可
      }
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
        matchStage.tags = { $regex: /netflix/i }
      } else if (["4k", "2160p"].includes(lowerTag)) {
        // 💎 4K 模式
        matchStage.tags = { $in: ["4K", "4k", "2160P"] }
      } else if (
        ["nba", "cba", "f1", "欧冠", "世界杯", "奥运会"].includes(lowerTag)
      ) {
        matchStage.$or = [
          { title: { $regex: new RegExp(tag, "i") } }, // 搜标题
          { tags: { $regex: new RegExp(tag, "i") } }, // 保险起见，也搜一下tag
        ]
      } else {
        // 🏷️ 普通标签 (通用正则匹配，忽略大小写)
        matchStage.tags = { $regex: new RegExp(tag, "i") }
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
    } else if (sort === "year" || sort === "time") {
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
  const cacheKey = `sources_search_v2_${encodeURIComponent(title)}`
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

    // 拍平数组
    let availableSources = results.flat()

    if (availableSources.length === 0) {
      return success(res, [])
    }

    // 👇 2. 【核心新增】给全网搜索的结果也加上优先级排序逻辑
    availableSources.sort((a, b) => {
      let indexA = PRIORITY_LIST.indexOf(a.source_key)
      let indexB = PRIORITY_LIST.indexOf(b.source_key)

      // 如果配置里没写的源，放到最后面 (给 999 权重)
      if (indexA === -1) indexA = 999
      if (indexB === -1) indexB = 999

      return indexA - indexB // 升序排列，index 越小越优先
    })

    // 存入缓存
    await setCache(cacheKey, availableSources, 600)

    success(res, availableSources)
  } catch (e) {
    console.error("Search Sources Error:", e)
    fail(res, "搜索源失败")
  }
}

exports.matchResource = async (req, res) => {
  const { tmdb_id, category, title, year } = req.query

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
    // 🎯 策略 A: TMDB ID 精准匹配
    // ==========================================
    if (tmdb_id) {
      // 1. 先判断是不是误传了 MongoDB 的 _id (24位 hex 字符串)
      // 如果是，直接按 _id 找，不用再匹配了
      if (/^[0-9a-fA-F]{24}$/.test(tmdb_id)) {
        try {
          video = await Video.findById(tmdb_id)
          if (video)
            console.log(`[Match] 通过 MongoID 直接命中: ${video.title}`)
        } catch (e) {}
      }

      // 2. 如果没找到，再当做 TMDB ID (数字) 去找
      if (!video) {
        const tmdbIdNum = parseInt(tmdb_id)
        if (!isNaN(tmdbIdNum)) {
          video = await Video.findOne({ tmdb_id: tmdbIdNum })
        }
      }
    }

    // ==========================================
    // 🔎 策略 B: 智能模糊匹配 (核心优化)
    // ==========================================
    if (!video && title) {
      // 🛠️ 1. 标题清洗：移除 "第二季", "Season 2", "Netflix" 等干扰词，提高命中率
      const cleanTitle = title
        .replace(/（.*?）|\(.*?\)/g, "") // 去括号
        .replace(/(第.季|Season \d+|Netflix|4K|1080P)/gi, "") // 去修饰词
        .trim()

      console.log(
        `[Match] 原始: ${title} -> 清洗后: ${cleanTitle} (Cat: ${category})`,
      )

      const query = {}

      // 🛠️ 2. 标题模糊查询 (Regex)
      // 使用正则包含匹配，且忽略大小写
      // 对正则特殊字符进行转义，防止报错
      const safeTitle = cleanTitle.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
      query.title = { $regex: new RegExp(safeTitle, "i") }

      // 🛠️ 3. 分类智能映射 (解决 tv != 日本动漫 的问题)
      if (category && category !== "all") {
        const catMap = {
          // 只要前端传了 movie，就在这些中文分类里找
          movie: [
            "电影",
            "动作",
            "科幻",
            "爱情",
            "喜剧",
            "恐怖",
            "剧情",
            "战争",
            "灾难",
            "Netflix",
          ],
          // 只要前端传了 tv，就在这些中文分类里找
          tv: [
            "剧集",
            "国产",
            "欧美",
            "韩剧",
            "日剧",
            "日本",
            "动漫",
            "日本动漫",
            "海外",
            "Netflix",
          ],
          anime: ["动漫", "日本动漫", "国产动漫"],
          variety: ["综艺", "大陆综艺", "日韩综艺"],
        }

        // 如果映射表里有，就用 $in 查询；如果没有，就模糊匹配一下
        const targetCats = catMap[category]
        if (targetCats) {
          // 搜 category 字段 或者 tags 字段
          query.$or = [
            { category: { $in: targetCats } },
            { tags: { $in: targetCats } }, // 有时候分类标错了，但标签是对的
          ]
        } else {
          // 兜底：如果传了未知的分类，尝试模糊匹配
          query.category = { $regex: new RegExp(category, "i") }
        }
      }

      // 🔒 4. 年份模糊校验 (保持原样，这逻辑挺好)
      if (year) {
        const y = parseInt(year)
        if (!isNaN(y)) {
          // 如果前面有 $or 查询，这里必须小心合并
          // 使用 $and 确保年份限制对 $or 里的条件都生效
          const yearQuery = { year: { $gte: y - 1, $lte: y + 1 } }
          if (query.$or) {
            query.$and = [yearQuery, { $or: query.$or }]
            delete query.$or // 移入 $and
          } else {
            query.year = yearQuery.year
          }
        }
      }

      // 🔒 5. 黑名单 (保持原样)
      query.original_type = { $not: /短剧|爽文|爽剧/ }

      // 执行查询，优先找 rating 高的，或者最近更新的
      video = await Video.findOne(query).sort({ updatedAt: -1 })
    }

    // ==========================================
    // 🚀 结果提取
    // ==========================================
    if (video) {
      // (保持原有的提取 source 和 episode 逻辑不变)
      let finalEpisodeCount = 0
      let finalPlayFrom = "unknown"

      if (video.sources && video.sources.length > 0) {
        const firstSource = video.sources[0]
        finalPlayFrom = firstSource.source_key
        finalEpisodeCount = firstSource.vod_play_url
          ? firstSource.vod_play_url.split("#").length
          : 0
      } else if (video.vod_play_url) {
        finalPlayFrom = video.source || "unknown"
        finalEpisodeCount = video.vod_play_url.split("#").length
      }

      // 只要找到了，不管有没有播放源，先返回 found: true
      // (有些资源可能暂时没集数，但至少匹配到了详情)
      return success(res, {
        found: true,
        id: video._id.toString(),
        title: video.title,
        source: finalPlayFrom,
        episodes_count: finalEpisodeCount,
        year: video.year,
        // 告诉前端匹配到了什么分类，方便调试
        matched_category: video.category,
      })
    }

    return success(res, { found: false, message: "本地库暂未收录" })
  } catch (e) {
    console.error("Match Error:", e)
    return fail(res, "匹配异常")
  }
}

exports.ingestVideo = async (req, res) => {
  const { title } = req.body
  if (!title) return res.json({ code: 400, message: "缺少影片名称" })

  try {
    // 1. 先查本地库是否已经有了 (防止用户重复点击)
    const safeTitle = title.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
    const existVideo = await Video.findOne({
      title: { $regex: new RegExp(safeTitle, "i") },
    })

    if (existVideo) {
      return res.json({
        code: 200,
        message: "该影片已在片库中",
        id: existVideo._id.toString(),
      })
    }

    console.log(`\n================================`)
    console.log(`[Ingest] 🚀 触发一键采录: 关键词【${title}】`)

    // 2. 去全网资源站进行搜索
    const allSourceKeys = Object.keys(sources)
    const searchPromises = allSourceKeys.map(async (key) => {
      const sourceConfig = sources[key]
      try {
        const response = await axios.get(sourceConfig.url, {
          params: { ac: "detail", wd: title },
          timeout: 8000, // 超时时间稍微拉长一点到 8 秒
          ...getAxiosConfig(),
        })
        const list = response.data?.list || []

        // 🔥 核心修复 1：双向模糊匹配，忽略大小写
        const validItems = list.filter((item) => {
          const vName = item.vod_name.toLowerCase()
          const tName = title.toLowerCase()
          // 只要资源站的名字包含搜索词，或者搜索词包含资源站名字，都算命中！
          return vName.includes(tName) || tName.includes(vName)
        })

        if (validItems.length > 0) {
          console.log(
            `[Ingest] ✅ ${sourceConfig.name} 命中 ${validItems.length} 条资源`,
          )
        }

        return validItems.map((item) => ({
          ...item,
          source_key: key,
        }))
      } catch (err) {
        // 🔥 核心修复 2：把真正的报错原因打印出来
        console.error(`[Ingest] ❌ ${sourceConfig.name} 请求失败:`, err.message)
        return []
      }
    })

    const results = await Promise.all(searchPromises)
    const availableSources = results.flat()

    if (availableSources.length === 0) {
      console.log(`[Ingest] 🚫 采录失败: 全网均未搜到【${title}】`)
      return res.json({ code: 404, message: "抱歉，全网暂未找到该影视资源" })
    }

    // 🔥 核心修复 3：按照配置的优先级 (feifan > liangzi) 重新洗牌
    availableSources.sort((a, b) => {
      let indexA = PRIORITY_LIST.indexOf(a.source_key)
      let indexB = PRIORITY_LIST.indexOf(b.source_key)
      if (indexA === -1) indexA = 999
      if (indexB === -1) indexB = 999
      return indexA - indexB
    })

    // 取最靠谱的第一个源进行本地格式化入库
    const bestMatch = availableSources[0]
    console.log(
      `[Ingest] 🌟 准备入库最优解: 【${bestMatch.vod_name}】(源自: ${bestMatch.source_key})`,
    )

    // 简单智能分类映射
    let localCategory = "movie"
    const typeName = bestMatch.type_name || ""
    if (typeName.includes("剧")) localCategory = "tv"
    else if (typeName.includes("综艺") || typeName.includes("晚会"))
      localCategory = "variety"
    else if (typeName.includes("动漫") || typeName.includes("动画"))
      localCategory = "anime"

    const newVideo = new Video({
      title: bestMatch.vod_name,
      poster: bestMatch.vod_pic,
      category: localCategory,
      year: bestMatch.vod_year,
      area: bestMatch.vod_area,
      content: bestMatch.vod_content,
      actors: bestMatch.vod_actor,
      director: bestMatch.vod_director,
      remarks: bestMatch.vod_remarks,
      sources: [
        {
          source_key: bestMatch.source_key,
          vod_id: bestMatch.vod_id,
          vod_name: bestMatch.vod_name,
          vod_play_from: bestMatch.vod_play_from,
          vod_play_url: bestMatch.vod_play_url,
          remarks: bestMatch.vod_remarks,
        },
      ],
    })

    await newVideo.save()
    console.log(`[Ingest] 🎉 入库成功，MongoDB ID: ${newVideo._id}`)

    return res.json({
      code: 200,
      message: "🎉 收录成功！",
      id: newVideo._id.toString(),
    })
  } catch (e) {
    console.error("[Ingest Error] 致命错误:", e)
    return res.json({ code: 500, message: "服务器收录时发生异常" })
  }
}
