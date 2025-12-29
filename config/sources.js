// config/sources.js

/**
 * 🛠️ ID 映射模板说明：
 *
 * 模板 A (Standard): 适用于 红牛、索尼、百度、光速、金鹰 等
 * - 电影: 动作片=5, 喜剧=6...
 * - 剧集: 国产=13...
 * - 动漫: 4 (直接包含数据)
 * - 综艺: 3 (直接包含数据)
 *
 * 模板 B (Offset): 适用于 量子、非凡、ikzy 等
 * - 电影: 动作片=6 (比标准大1)
 * - 动漫: 4是空壳 -> 需映射到 29 (国产动漫) 或 30 (日韩)
 * - 综艺: 3是空壳 -> 需映射到 25 (国产综艺)
 */

const MAP_STANDARD = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  13: 13,
  14: 14,
  15: 15,
  16: 16,
}

const MAP_OFFSET = {
  // 电影 (整体+1)
  1: 6, // 兜底
  5: 6,
  6: 7,
  7: 8,
  8: 9,
  9: 10,
  10: 11,
  11: 12,
  // 剧集 (通常一致)
  2: 13, // 兜底
  13: 13,
  14: 14,
  15: 15,
  16: 16,
  // 综艺 & 动漫 (需映射到子类)
  3: 25, // 默认国产综艺
  4: 29, // 默认国产动漫
  // 子类透传
  25: 25,
  26: 26,
  27: 27,
  28: 28,
  29: 29,
  30: 30,
  31: 31,
}

module.exports = {
  // 🚀 轮询优先级 (从快到慢，从 HTTPS 到 HTTP)
  // 建议将速度快、画质好的大厂放在前面
  PRIORITY_LIST: [
    "sony", // 索尼: 首选，稳
    "zy1080", // 优质: 画质好
    "liangzi", // 量子: 资源全
    "feifan", // 非凡: 更新快
    "guangsu", // 光速
    "baidu", // 百度
    "jinying", // 金鹰
    "shandian", // 闪电
    "yinghua", // 樱花
    "hongniu", // 红牛
    "wuxian", // 无线
    "fengchao", // 蜂巢
    "tianya", // 天涯
    // "dytt",   // 电影天堂 (HTTP，容易报错，放最后)
  ],

  sources: {
    // 1. 索尼资源 (标准ID)
    sony: {
      name: "索尼资源",
      url: "https://sonyapi.net/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 2. 优质资源 (1080) (标准ID)
    zy1080: {
      name: "优质资源",
      url: "https://api.1080zyku.com/inc/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 3. 量子资源 (偏移ID)
    liangzi: {
      name: "量子资源",
      url: "https://cj.lziapi.com/api.php/provide/vod/",
      id_map: MAP_OFFSET,
      home_map: { movie_hot: 6, tv_cn: 13, anime: 30 }, // 推荐日韩动漫
    },

    // 4. 非凡资源 (偏移ID)
    feifan: {
      name: "非凡资源",
      url: "https://cj.ffzyapi.com/api.php/provide/vod/",
      id_map: MAP_OFFSET,
      home_map: { movie_hot: 6, tv_cn: 13, anime: 29 },
    },

    // 5. 光速资源 (标准ID)
    guangsu: {
      name: "光速资源",
      url: "https://api.guangsuapi.com/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 6. 百度资源 (标准ID)
    baidu: {
      name: "百度资源",
      url: "https://api.apibdzy.com/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 7. 金鹰资源 (标准ID)
    jinying: {
      name: "金鹰资源",
      url: "https://jyzyapi.com/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 8. 闪电资源 (标准ID)
    shandian: {
      name: "闪电资源",
      url: "https://sdzyapi.com/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 9. 红牛资源 (标准ID)
    hongniu: {
      name: "红牛资源",
      url: "https://www.hongniuzy2.com/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 10. 樱花资源 (通常是标准，有时不稳定)
    yinghua: {
      name: "樱花资源",
      url: "https://m3u8.apiyhzy.com/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 11. 无线资源
    wuxian: {
      name: "无线资源",
      url: "https://api.wuxianzy.net/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 12. 蜂巢片库
    fengchao: {
      name: "蜂巢资源",
      url: "https://api.fczy888.me/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 13. 天涯影视
    tianya: {
      name: "天涯资源",
      url: "https://tyyszyapi.com/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 14. 电影天堂 (HTTP，可能被浏览器拦截混合内容，慎用)
    // 建议放在最后，仅在其他都挂了时尝试
    dytt: {
      name: "电影天堂",
      url: "http://caiji.dyttzyapi.com/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },
  },
}
