module.exports = {
  // 定义轮询顺序：优先用索尼和1080（通常最快），量子备用
  // 后端会按照这个数组顺序依次尝试，直到成功
  PRIORITY_LIST: ["sony", "zy1080", "liangzi", "feifan", "guangsu"],

  sources: {
    // 1. 索尼资源 (目前非常稳，HTTPS，速度快)
    sony: {
      name: "索尼资源",
      url: "https://sonyapi.net/api.php/provide/vod/",
      id_map: {
        // 索尼的ID通常是标准的
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
      },
      home_map: { movie_hot: 1, tv_cn: 13, anime: 4 }, // 索尼ID 1 通常包含所有电影
    },

    // 2. 优质资源 (1080zyku) - 画质好，更新快
    zy1080: {
      name: "优质资源",
      url: "https://api.1080zyku.com/inc/api.php/provide/vod/",
      id_map: {
        // 优质资源的ID可能有偏移，这里按通用配置，如不对需微调
        1: 5,
        5: 5,
        6: 6,
        7: 7,
        8: 8,
        9: 9,
        2: 13,
        13: 13,
        14: 14,
        15: 15,
        16: 16,
        3: 3,
        4: 4,
      },
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },

    // 3. 量子资源 (老牌)
    liangzi: {
      name: "量子资源",
      url: "https://cj.lziapi.com/api.php/provide/vod/",
      id_map: {
        1: 6,
        5: 6,
        6: 7,
        7: 8,
        8: 9,
        9: 10,
        10: 11,
        11: 12,
        2: 13,
        13: 13,
        14: 14,
        15: 15,
        16: 16,
        3: 25,
        4: 29,
      },
      home_map: { movie_hot: 6, tv_cn: 13, anime: 30 },
    },

    // 4. 非凡资源
    feifan: {
      name: "非凡资源",
      url: "https://cj.ffzyapi.com/api.php/provide/vod/",
      id_map: {
        1: 6,
        5: 6,
        6: 7,
        7: 8,
        8: 9,
        9: 10,
        2: 13,
        13: 13,
        14: 14,
        15: 15,
        16: 16,
        3: 25,
        4: 29,
      },
      home_map: { movie_hot: 6, tv_cn: 13, anime: 29 },
    },

    // 5. 光速资源
    guangsu: {
      name: "光速资源",
      url: "https://api.guangsuapi.com/api.php/provide/vod/",
      id_map: {
        1: 5,
        5: 5,
        6: 6,
        7: 7,
        8: 8,
        9: 9,
        2: 13,
        13: 13,
        14: 14,
        15: 15,
        16: 16,
        3: 3,
        4: 4,
      },
      home_map: { movie_hot: 5, tv_cn: 13, anime: 4 },
    },
  },
}
