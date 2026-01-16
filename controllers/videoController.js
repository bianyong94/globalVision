const Video = require("../models/Video")
const { getCache, setCache } = require("../utils/cache")
const {
  smartFetch,
  saveToDB,
  getAxiosConfig,
} = require("../services/videoService")
const { sources } = require("../config/constants")
const axios = require("axios")

const success = (res, data) => res.json({ code: 200, message: "success", data })
const fail = (res, msg = "Error", code = 500) =>
  res.json({ code, message: msg })

exports.getVideos = async (req, res) => {
  try {
    const { cat, tag, area, year, sort, pg = 1, wd } = req.query
    const limit = 20
    const skip = (parseInt(pg) - 1) * limit

    // ==========================================
    // 1. 构建筛选条件 ($match)
    // ==========================================
    const matchStage = {}
    let sortStage = { updatedAt: -1 }
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

    // 🏷️ 标签筛选
    if (tag) {
      matchStage.tags = tag
      // 如果是找“高分”或“豆瓣榜单”，必须过滤掉 0 分的垃圾数据
      if (tag === "high_score" || tag === "douban_top") {
        matchStage.rating = { $gt: 0 }
      }
    }

    // ==========================================
    // 2. 构建智能排序逻辑 ($sort) 🔥 核心修改
    // ==========================================

    if (sort === "rating" || tag === "high_score" || tag === "高分电影") {
      // 1. 强制只看 TMDB 清洗过的数据 (关键！排除采集站的假 10 分)
      matchStage.tmdb_id = { $exists: true }

      // 2. 强制评分门槛 (例如大于 7.0 分)
      matchStage.rating = { $gt: 6.5 }
      if (!cat || cat === "all") {
        matchStage.category = "movie"
      }

      // ✅ 场景 A: 用户想看【高分】
      // 逻辑：先看分数 -> 分数一样看年份(越新越好) -> 年份一样看更新时间
      sortStage = {
        rating: -1, // 1. 评分优先 (10分 > 9分)
        year: -1, // 2. 年份次之 (同9分，2025 > 1990)
        updatedAt: -1, // 3. 更新时间兜底 (同分同年，刚更新的在前后)
      }

      // 再次确保，按评分排时，如果没有筛选 rating>0，这里强制过滤 0 分
      // 避免 0 分的数据因为 year 很大而混在中间（虽然 sort rating:-1 会把 0 放最后，但为了保险）
      if (!matchStage.rating) {
        matchStage.rating = { $gt: 0 }
      }
    } else if (tag === "netflix") {
      matchStage.tags = "netflix"
      // Netflix 专区也建议优先展示清洗过的数据
      // matchStage.tmdb_id = { $exists: true };
    } else if (tag === "4k") {
      matchStage.tags = { $in: ["4K", "4k"] }
    } else {
      // ✅ 场景 B: 用户想看【最新】(默认)
      // 逻辑：先看年份 -> 年份一样看更新时间(集数更新) -> 都一样看评分(质量)
      sortStage = {
        year: -1, // 1. 绝对年份优先 (2026 > 2025)
        updatedAt: -1, // 2. 也是2025，刚更新第16集的排在第10集前面
        rating: -1, // 3. 都是2025且同时更新，9.0分的排在2.0分前面
      }
    }

    // 📶 排序参数处理 (sort 参数)
    if (sort === "rating") {
      // 🔥 如果用户手动点击了 "按评分"，也必须过滤垃圾数据
      matchStage.tmdb_id = { $exists: true } // 必须有 TMDB ID
      matchStage.rating = { $gt: 0 } // 分数必须大于 0
      sortStage = { rating: -1, year: -1 }
    } else if (sort === "year") {
      sortStage = { year: -1, updatedAt: -1 }
    }

    // ==========================================
    // 3. 执行聚合查询 (Aggregation)
    // ==========================================
    const pipeline = [
      { $match: matchStage }, // 1. 筛选
      { $sort: sortStage }, // 2. 排序
      { $skip: skip }, // 3. 跳页
      { $limit: limit }, // 4. 限制数量
      {
        $project: {
          // 5. 输出字段 (精简数据量)
          title: 1,
          poster: 1,
          rating: 1,
          year: 1,
          remarks: 1,
          tags: 1,
          uniq_id: 1,
          category: 1,
          updatedAt: 1, // 输出这个方便调试看排序是否生效
          id: "$uniq_id", // 别名映射，前端展示需要 id
        },
      },
    ]

    const list = await Video.aggregate(pipeline)

    // ==========================================
    // 4. 返回结果
    // ==========================================
    res.json({ code: 200, list: list })
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
  const { id } = req.params // 例如: "hongniu_951"

  // 1. 缓存检查 (缓存 10 分钟)
  // 注意：开发调试时可以注释掉这就行，方便看实时日志
  const cacheKey = `detail_v4_${id}`
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  // 解析播放列表 (工具函数)
  const parseEpisodes = (urlStr, fromStr) => {
    if (!urlStr) return []
    const froms = (fromStr || "").split("$$$")
    const urls = urlStr.split("$$$")
    // 优先找 m3u8，找不到就找默认的
    let idx = froms.findIndex((f) => f && f.toLowerCase().includes("m3u8"))
    if (idx === -1) idx = 0
    const targetUrl = urls[idx] || ""
    if (!targetUrl) return []

    return targetUrl.split("#").map((ep) => {
      const parts = ep.split("$")
      return {
        name: parts.length > 1 ? parts[0] : "正片",
        link: parts.length > 1 ? parts[1] : parts[0],
      }
    })
  }

  try {
    let videoDetail = null
    let sourceKey = ""
    let vodId = ""

    // ==========================================
    // 步骤 A: 解析 ID，确定要查询的源
    // ==========================================
    if (id.includes("_") || id.includes("$")) {
      const separator = id.includes("_") ? "_" : "$"
      const parts = id.split(separator)
      sourceKey = parts[0] // "hongniu"
      vodId = parts[1] // "951"
    } else {
      // 兼容旧 ID (纯数字)，默认去非凡查，或者查库
      const exist = await Video.findOne({ vod_id: id })
      if (exist) {
        sourceKey = exist.source
        vodId = String(exist.vod_id)
      } else {
        sourceKey = "feifan" // 默认兜底
        vodId = id
      }
    }

    // ==========================================
    // 步骤 B: 尝试从数据库获取
    // ==========================================
    // 构造查询条件：同时匹配源和ID，防止ID冲突
    videoDetail = await Video.findOne({
      $or: [
        { uniq_id: `${sourceKey}_${vodId}` }, // 新格式
        { uniq_id: `${sourceKey}$${vodId}` }, // 旧格式
        { id: `${sourceKey}_${vodId}` }, // 兼容格式
      ],
    })

    // ==========================================
    // 步骤 C: 数据库没有 -> 触发回源采集 (关键修复)
    // ==========================================
    if (!videoDetail) {
      console.log(
        `🚀 [Detail] DB Miss, Fetching Remote: ${sourceKey} -> ${vodId}`
      )

      // 1. 检查源是否存在于配置中
      const targetSource = sources[sourceKey]
      if (!targetSource) {
        return fail(res, `未知的资源站标识: ${sourceKey}`, 400)
      }

      try {
        // 2. 发起请求 (不使用 smartFetch 的自动竞速，而是强制指定源)
        // ⚠️ 红牛等源速度极慢，给予 8秒 超时
        const response = await axios.get(targetSource.url, {
          params: { ac: "detail", at: "json", ids: vodId },
          timeout: 8000,
          ...getAxiosConfig(),
        })

        // 3. 校验返回数据
        if (
          response.data &&
          response.data.list &&
          response.data.list.length > 0
        ) {
          const rawData = response.data.list[0]
          // 4. 存入数据库 (异步)
          // 必须 await 确保 videoDetail 被赋值
          videoDetail = await saveToDB(rawData, sourceKey)
          console.log(`✅ [Detail] Saved to DB: ${videoDetail.title}`)
        } else {
          console.warn(
            `⚠️ [Detail] Remote API returned empty list: ${sourceKey}`
          )
          return fail(res, "源站返回数据为空，可能资源已失效", 404)
        }
      } catch (fetchErr) {
        console.error(
          `❌ [Detail] Fetch Failed (${sourceKey}):`,
          fetchErr.message
        )
        return fail(res, `源站连接超时或错误: ${fetchErr.message}`, 500)
      }
    }

    // 双重检查
    if (!videoDetail) return fail(res, "资源解析失败", 500)

    // ==========================================
    // 步骤 D: 构建“可用源”列表 (混合模式)
    // ==========================================

    // 1. 数据库里的同名资源 (已采集的)
    const siblings = await Video.find({
      title: videoDetail.title,
    }).select("uniq_id source remarks")

    // 2. 配置文件里的所有源 (静态的)
    // 我们把配置文件里的源也都列出来，方便前端展示“去搜索”按钮
    // 这里的逻辑是：结合数据库已有的状态，生成一个完整的列表
    const allConfiguredSources = Object.keys(sources).map((key) => {
      const sourceConfig = sources[key]
      // 查找数据库里是否已经有这个源的数据
      const existing = siblings.find((s) => s.source === key)

      return {
        key: key,
        name: sourceConfig.name,
        // 如果库里有，就用库里的ID；如果库里没有，前端点击时需要触发“全网搜”
        id: existing ? existing.uniq_id : null,
        remarks: existing ? existing.remarks : "点击搜索",
        is_active: key === sourceKey, // 标记是否是当前播放的源
        has_data: !!existing, // 标记库里是否有数据
      }
    })

    // ==========================================
    // 步骤 E: 返回最终数据
    // ==========================================
    const responseData = {
      id: videoDetail.uniq_id, // 核心 ID
      uniq_id: videoDetail.uniq_id,

      title: videoDetail.title,
      pic: videoDetail.poster || videoDetail.pic,
      year: videoDetail.year,
      area: videoDetail.area,
      content: videoDetail.overview || videoDetail.content,
      actors: videoDetail.actors,
      director: videoDetail.director,
      category: videoDetail.category,
      tags: videoDetail.tags,

      // 播放列表
      episodes: parseEpisodes(
        videoDetail.vod_play_url,
        videoDetail.vod_play_from
      ),

      // 🔥 修复后的源列表 (包含所有配置源)
      available_sources: allConfiguredSources,

      current_source: {
        key: videoDetail.source,
        name: sources[videoDetail.source]?.name || videoDetail.source,
      },
    }

    // 写入缓存
    await setCache(cacheKey, responseData, 600)
    success(res, responseData)
  } catch (e) {
    console.error("🔥 Global Detail Error:", e)
    fail(res, "服务器内部错误: " + e.message)
  }
}

exports.searchSources = async (req, res) => {
  const { title } = req.query

  if (!title) return fail(res, "缺少标题参数", 400)

  // 1. 缓存检查 (同一个片名搜索结果缓存 10 分钟)
  // 这种实时聚合查询比较消耗服务器带宽，建议加上缓存
  const cacheKey = `sources_search_${encodeURIComponent(title)}`
  const cachedData = await getCache(cacheKey)
  if (cachedData) return success(res, cachedData)

  try {
    // 2. 获取所有配置的源
    // 我们不使用 PRIORITY_LIST，而是使用 sources 对象的所有 Key，以获取最全的结果
    const allSourceKeys = Object.keys(sources)

    // 3. 并发请求所有源
    // 使用 Promise.allSettled 防止某一个源挂了导致整个接口失败
    const searchPromises = allSourceKeys.map(async (key) => {
      const source = sources[key]
      try {
        // 大多数资源站的搜索接口参数是 wd={title}
        // ac=detail 可以直接获取详情，如果不支持可以改 ac=list
        const response = await axios.get(source.url, {
          params: { ac: "detail", wd: title },
          timeout: 10000, // 设置 4s 超时，防止接口太慢
          ...getAxiosConfig(), // 复用你的代理/Header配置
        })

        const list = response.data?.list || []

        // 4. 精确匹配逻辑
        // 资源站搜索是模糊的，搜"庆余年"可能会出来"庆余年花絮"
        // 我们需要找到跟当前标题高度匹配的那个
        const match = list.find(
          (item) =>
            // 完全相等，或者包含关系(容错)
            item.vod_name === title ||
            (item.vod_name.includes(title) &&
              item.vod_name.length < title.length + 2)
        )

        if (match) {
          return {
            key: key, // 源标识 (feifan)
            name: source.name, // 源名称 (非凡资源)
            // 构造前端跳转需要的 ID 格式
            id: `${key}_${match.vod_id}`,
            // 顺便把更新状态带回去，方便用户对比 (如: "非凡: 更新至30集" vs "量子: 全36集")
            remarks: match.vod_remarks,
            // 如果需要，可以把播放地址也带上，预加载
            // type: match.type_name
          }
        }
        return null
      } catch (err) {
        // console.warn(`源 ${source.name} 搜索超时或失败`);
        return null // 失败忽略
      }
    })

    const results = await Promise.all(searchPromises)

    // 5. 过滤掉无效结果
    const availableSources = results.filter((item) => item !== null)

    if (availableSources.length === 0) {
      // 如果全网都没搜到，返回空数组
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
  // 1. 接收参数增加 year (年份)
  const { tmdb_id, category, title, year } = req.query

  if (!tmdb_id && !title) {
    return fail(res, "缺少匹配参数", 400)
  }

  try {
    let video = null

    // 🎯 策略 A: TMDB ID 精准匹配 (最稳)
    if (tmdb_id) {
      const tmdbIdNum = parseInt(tmdb_id)
      if (!isNaN(tmdbIdNum)) {
        video = await Video.findOne({ tmdb_id: tmdbIdNum })
      }
      if (!video) {
        video = await Video.findOne({ tmdb_id: tmdb_id })
      }
    }

    // 🔎 策略 B: 标题兜底匹配 (必须加入年份校验！)
    if (!video && title) {
      console.log(`[Match] 尝试标题匹配: ${title} (${year || "无年份"})`)

      const query = { title: title }

      // 🔒 1. 强分类校验
      if (category && category !== "all") {
        query.category = category
      }

      // 🔒 2. 年份模糊校验 (关键修复！)
      // 如果前端传了年份 (比如 1972)，我们只匹配 1971-1973 之间的数据
      // 防止匹配到 2024 年的同名短剧
      if (year) {
        const y = parseInt(year)
        if (!isNaN(y)) {
          query.year = { $gte: y - 1, $lte: y + 1 }
        }
      }

      // 🔒 3. 排除短剧特征 (双重保险)
      // 如果是找电影(movie)，排除集数过多的
      // 这里无法直接查集数，但可以利用正则表达式排除 title 里的垃圾词 (虽然 title 已经是完全匹配了)
      // 或者依赖分类器已经把短剧归类为 'tv' 或 'other' 了，所以 query.category 限制很重要
      // 🔥 3. 新增：原始分类黑名单校验
      // 即使标题一样，如果 original_type 是短剧，绝对不要匹配
      query.original_type = { $not: /短剧|爽文|爽剧|反转|赘婿/ }

      video = await Video.findOne(query).sort({ updatedAt: -1 })

      // 🔥 4. 新增：二次校验 (防止电影匹配到多集短剧)
      // 如果前端要找的是 movie (category='movie' 或 TMDB判断是电影)
      // 但数据库里查出来的这货竟然有 > 5 集，那它肯定是假冒的短剧
      if (
        video &&
        (category === "movie" || !video.category || video.category === "movie")
      ) {
        const episodeCount = video.vod_play_url
          ? video.vod_play_url.split("#").length
          : 0
        if (episodeCount > 5) {
          console.log(
            `[Match] 拦截伪装数据: ${video.title} (集数: ${episodeCount}, 类型: ${video.original_type})`
          )
          video = null // 扔掉这个假结果
        }
      }

      video = await Video.findOne(query).sort({ updatedAt: -1 })
    }

    if (video) {
      return success(res, {
        found: true,
        id: video.uniq_id,
        title: video.title,
        source: video.source,
        // 返回集数方便前端判断
        episodes_count: video.vod_play_url
          ? video.vod_play_url.split("#").length
          : 0,
      })
    } else {
      return success(res, { found: false, message: "未找到匹配资源" })
    }
  } catch (e) {
    console.error("Match Error:", e)
    fail(res, "匹配错误")
  }
}
