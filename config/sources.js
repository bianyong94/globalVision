// config/sources.js

/**
 * 🛠️ 大陆极速版配置
 * 策略：启用针对国内网络优化的“非凡”和“量子”作为主力，确保秒播。
 * 核心：非凡(极速) + 量子(极速) + 暴风(稳定) + 金鹰(备用)
 * ID标准：已核实，以下源均符合 1=电影, 2=剧集, 3=综艺, 4=动漫 的标准。
 */

// 🟢 标准分类 ID
const MAP_STANDARD = {
  1: 1, // 电影
  2: 2, // 电视剧
  3: 3, // 综艺
  4: 4, // 动漫
  6: 6, // 动作片
  7: 7, // 喜剧片
  8: 8, // 爱情片
  9: 9, // 科幻片
  10: 10, // 恐怖片
  11: 11, // 剧情片
  12: 12, // 战争片
  13: 13, // 国产剧
  14: 14, // 港台剧
  15: 15, // 欧美剧
  16: 16, // 日韩剧
  // 注意：部分源可能将纪录片放在 20 或其他 ID，但主要分类是一致的
}

// 🛠️ 父子分类关系 (保持不变，通用)
const CATEGORY_RELATIONS = {
  // 1. 电影
  1: [6, 7, 8, 9, 10, 11, 12, 20, 21, 22, 34, 40],
  // 2. 电视剧
  2: [13, 14, 15, 16, 23, 24, 25, 41],
  // 3. 综艺
  3: [25, 26, 27, 28, 42],
  // 4. 动漫
  4: [29, 30, 31, 32, 33, 43],
}

module.exports = {
  CATEGORY_RELATIONS,

  // 🚀 竞速优先级 (速度优先)
  PRIORITY_LIST: [
    // "feifan", // 🚀 非凡: 目前国内速度最快，资源更新最快
    // "liangzi", // ⚛️ 量子: 速度与非凡并列，资源库巨大
    // "baofeng", // 🌪️ 暴风: 老牌稳定，无广告或少广告，速度尚可
    // "jinying", // 🦅 金鹰: 优质备用，画质通常不错
    // "hongniu", // 🐂 红牛: 降级为兜底，因为国内访问慢
    "maotai", // 🍶 茅台: 也不错，作为最后备选
  ],

  sources: {
    // ===========================
    // 1️⃣ 极速第一梯队 (国内优化)
    // ===========================

    // 🚀 非凡资源 (速度王)
    feifan: {
      name: "非凡资源",
      // 必须使用 ffm3u8 后缀，确保是 m3u8 格式
      url: "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // ⚛️ 量子资源 (速度王)
    liangzi: {
      name: "量子资源",
      url: "https://cj.lziapi.com/api.php/provide/vod/from/lzm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // ===========================
    // 2️⃣ 稳定第二梯队
    // ===========================

    // 🌪️ 暴风资源 (稳定)
    baofeng: {
      name: "暴风资源",
      url: "https://ad.bfzyapi.com/api.php/provide/vod/from/bfm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 🦅 金鹰资源 (画质好)
    jinying: {
      name: "金鹰资源",
      url: "https://jyzyapi.com/api.php/provide/vod/from/jym3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // ===========================
    // 3️⃣ 兜底梯队 (库大但慢)
    // ===========================

    // 🐂 红牛资源
    hongniu: {
      name: "红牛资源",
      url: "https://www.hongniuzy2.com/api.php/provide/vod/from/hnm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 👁️ 快看资源 (备用)
    kuaikan: {
      name: "快看资源",
      url: "https://kuaikanzy.net/api.php/provide/vod/from/kkm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },
    // 🍶 茅台资源
    maotai: {
      name: "茅台资源",
      url: "https://caiji.maotaizy.cc/api.php/provide/vod/from/mtm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },
  },
}
