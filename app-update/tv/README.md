TV APK 更新目录（静态托管）

访问路径：
- /app-update/tv/latest.json
- /app-update/tv/*.apk

发布流程：
1. 上传新 APK 到本目录，例如 `GlobalVisionTV-v1.0.1-release.apk`
2. 修改 `latest.json` 的 `versionName` / `versionCode` / `apkUrl`
3. 重启服务（或保留常驻由进程管理器自动加载静态文件变更）

注意：
- `versionCode` 必须递增
- `apkUrl` 必须是 HTTPS 可访问地址
