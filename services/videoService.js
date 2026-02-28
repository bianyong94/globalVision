async function processExternalItem(sourceKey, item) {
  try {
    const video = await Video.findOne({ title: item.vod_name })

    if (video) {
      // 👉 场景一：数据库已存在该剧
      const sourceIndex = video.sources.findIndex(
        (s) => s.source_key === sourceKey,
      )

      if (sourceIndex === -1) {
        // 1. 没有当前资源站的源 -> 新增这个站的源
        video.sources.push({
          source_key: sourceKey,
          vod_id: item.vod_id,
          vod_name: item.vod_name,
          vod_play_from: item.vod_play_from,
          vod_play_url: item.vod_play_url,
          remarks: item.vod_remarks,
        })
        video.updatedAt = new Date()
        await video.save()
        return "updated"
      } else {
        // 2. 核心修复：已有该源 -> 对比播放地址有没有变长（是不是更新了集数）
        const oldUrl = video.sources[sourceIndex].vod_play_url
        if (oldUrl !== item.vod_play_url) {
          video.sources[sourceIndex].vod_play_url = item.vod_play_url
          video.sources[sourceIndex].remarks = item.vod_remarks // 更新“更新至第x集”的字样
          video.updatedAt = new Date() // 刷新更新时间，这样它就会自动排到首页的最前面！
          await video.save()
          return "updated"
        }
      }
      return "no_change"
    } else {
      // 👉 场景二：核心修复：数据库里没有这部剧 -> 当做新剧全新入库！

      // 简单智能推断一下分类 (根据资源站返回的 type_name)
      let localCategory = "movie"
      const typeName = item.type_name || ""
      if (typeName.includes("剧")) localCategory = "tv"
      else if (typeName.includes("综艺") || typeName.includes("晚会"))
        localCategory = "variety"
      else if (typeName.includes("动漫") || typeName.includes("动画"))
        localCategory = "anime"

      // 顺便把资源站自带的海报、简介、演员等元数据一次性存入，摆脱对TMDB的依赖
      const newVideo = new Video({
        title: item.vod_name,
        poster: item.vod_pic,
        category: localCategory,
        year: item.vod_year,
        area: item.vod_area,
        content: item.vod_content,
        actors: item.vod_actor,
        director: item.vod_director,
        remarks: item.vod_remarks,
        sources: [
          {
            source_key: sourceKey,
            vod_id: item.vod_id,
            vod_name: item.vod_name,
            vod_play_from: item.vod_play_from,
            vod_play_url: item.vod_play_url,
            remarks: item.vod_remarks,
          },
        ],
      })
      await newVideo.save()
      return "inserted" // 标记为新增
    }
  } catch (e) {
    throw e
  }
}
