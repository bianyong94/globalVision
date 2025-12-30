// config/sources.js

/**
 * 🛠️ ID 映射模板说明：
 *
 * 🟢 标准源 (Standard): 索尼、红牛、茅台、极速、豆瓣 等
 * - 1=电影, 2=连续剧, 3=综艺, 4=动漫
 * - 子分类: 5=动作, 13=国产剧
 *
 * 🟠 偏移源 (Offset): 量子、非凡 (ikzy)
 * - 6=动作片, 13=国产剧
 * - 动漫(4)和综艺(3)通常无法直接查询，需映射到子类 (29=国产动漫, 30=日韩动漫)
 */

const MAP_STANDARD = {
  // 父类
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  // 电影子类
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  12: 12,
  // 剧集子类
  13: 13,
  14: 14,
  15: 15,
  16: 16,
  // 体育/纪录片 (部分源支持)
  20: 20, // 纪录片
  21: 21, // 体育
}

const MAP_OFFSET = {
  // 电影 (保留父类 1:1)
  1: 1,
  // 电影子类 (非凡/量子通常: 6=动作, 7=喜剧, 8=爱情, 9=科幻, 10=恐怖, 11=剧情, 12=战争)
  5: 6,
  6: 7,
  7: 8,
  8: 9,
  9: 10,
  10: 11,
  11: 12,
  // 剧集
  2: 2,
  13: 13,
  14: 14,
  15: 15,
  16: 16,
  // 综艺 & 动漫 (降级策略：只取国产/大陆，防止报错)
  3: 25, // 本地综艺 -> 远程国产综艺
  4: 29, // 本地动漫 -> 远程国产动漫
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
  // 🚀 轮询优先级 (从上到下竞速)
  // 策略：极速/索尼打头阵(快) -> 红牛/茅台/量子补全(全) -> 优质/豆瓣提质量
  PRIORITY_LIST: [
    "maotai", // 🍶 茅台: 老牌稳定，资源
    "sony", // 🌟 索尼: 综合最稳
    "hongniu", // 🔥 红牛: 资源库巨大
    "jisu", // ⚡️ 极速: 响应极快，适合首页
    "douban", // 🎬 豆瓣: 命名规范，质量尚可
    "liangzi", // ⚛️ 量子: 资源非常全，但ID有偏移
    "feifan", // 🚀 非凡: 速度快，ID有偏移
    "zy1080", // 📺 优质: 画质高 (1080P)
    "guangsu", // ⚡️ 光速
    // "shandian", // ⚡️ 闪电
    "wuxian", // 📡 无线
    "jinying", // 🦅 金鹰
    // "baidu", // 🔍 百度
    // "tianya", // 🌊 天涯
    "yinghua", // 🌸 樱花 (动漫多)
  ],

  sources: {
    // ===========================
    // 1️⃣ 第一梯队 (速度快/稳定)
    // ===========================

    // ⚡️ 极速资源 (新增)
    jisu: {
      name: "极速资源",
      // 锁定 jsm3u8 播放器，防止混入云播 iframe
      url: "https://jszyapi.com/api.php/provide/vod/from/jsm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 🌟 索尼资源
    sony: {
      name: "索尼资源",
      url: "https://suoniapi.com/api.php/provide/vod/from/snm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 🔥 红牛资源
    hongniu: {
      name: "红牛资源",
      url: "https://www.hongniuzy2.com/api.php/provide/vod/from/hnm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 🍶 茅台资源 (新增)
    maotai: {
      name: "茅台资源",
      // 锁定 mtm3u8
      url: "https://caiji.maotaizy.cc/api.php/provide/vod/from/mtm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // ===========================
    // 2️⃣ 第二梯队 (资源全/特殊ID)
    // ===========================

    // ⚛️ 量子资源 (偏移ID)
    liangzi: {
      name: "量子资源",
      url: "https://cj.lziapi.com/api.php/provide/vod/from/lzm3u8/",
      id_map: MAP_OFFSET,
      // 量子通常不支持 ID=1 查所有电影，建议 home_map 映射到 6 (动作片) 或保留 1 尝试
      home_map: { movie_hot: 6, tv_cn: 13, anime: 30 }, // 30=日韩动漫
    },

    // 🚀 非凡资源 (偏移ID)
    feifan: {
      name: "非凡资源",
      url: "https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8/",
      id_map: MAP_OFFSET,
      home_map: { movie_hot: 6, tv_cn: 13, anime: 29 },
    },

    // 🎬 豆瓣资源 (新增)
    douban: {
      name: "豆瓣资源",
      // 锁定 dbm3u8
      url: "https://caiji.dbzy5.com/api.php/provide/vod/from/dbm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // ===========================
    // 3️⃣ 第三梯队 (画质/备用)
    // ===========================

    // 📺 优质资源 (1080P)
    zy1080: {
      name: "优质资源",
      url: "https://api.1080zyku.com/inc/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // ⚡️ 光速资源
    guangsu: {
      name: "光速资源",
      url: "https://api.guangsuapi.com/api.php/provide/vod/from/gsm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // ⚡️ 闪电资源
    shandian: {
      name: "闪电资源",
      url: "https://sdzyapi.com/api.php/provide/vod/from/sdm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 📡 无线资源
    wuxian: {
      name: "无线资源",
      url: "https://api.wuxianzy.net/api.php/provide/vod/from/wxm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 🦅 金鹰资源
    jinying: {
      name: "金鹰资源",
      url: "https://jyzyapi.com/api.php/provide/vod/from/jym3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 🔍 百度资源
    baidu: {
      name: "百度资源",
      url: "https://api.apibdzy.com/api.php/provide/vod/from/dbm3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 🌊 天涯资源
    tianya: {
      name: "天涯资源",
      url: "https://tyyszyapi.com/api.php/provide/vod/from/tym3u8/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },

    // 🌸 樱花资源
    yinghua: {
      name: "樱花资源",
      url: "https://m3u8.apiyhzy.com/api.php/provide/vod/",
      id_map: MAP_STANDARD,
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 },
    },
  },
}
