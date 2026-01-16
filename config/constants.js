// 提取原文件中的常量
const STANDARD_GROUPS = {
  MOVIE: { id: 1, name: "电影", regex: /电影|片|大片|蓝光|4K|1080P/ },
  TV: { id: 2, name: "剧集", regex: /剧|连续剧|电视|集/ },
  VARIETY: { id: 3, name: "综艺", regex: /综艺|晚会|秀|演唱会|榜/ },
  ANIME: { id: 4, name: "动漫", regex: /动漫|动画|漫/ },
  SPORTS: { id: 5, name: "体育", regex: /体育|球|赛事|NBA|F1/ },
}

const BLACK_LIST = ["测试", "留言", "公告", "资讯", "全部影片"]

// 确保你已经有 config/sources.js，这里只是引用
const { sources, PRIORITY_LIST } = require("./sources")

module.exports = {
  STANDARD_GROUPS,
  BLACK_LIST,
  sources,
  PRIORITY_LIST,
}
