# Image Gallery Preview

在 VSCode / Cursor / 兼容 VSCode API 的 IDE 侧边栏中预览 Android、Flutter、iOS 资源文件。

## 功能说明

- 按 `Platform > Project > Module > Directory` 分组浏览资源。
- 支持图片、音频、视频、Lottie、Android vector XML 等资源类型。
- 支持按平台、项目、模块、媒体类型、格式筛选。
- 支持按文件名、相对路径、MD5 搜索。
- 支持点击卡片复制资源引用，点击 `M` 复制 MD5，点击 `i` 查看详细信息。
- 支持音视频点击播放按钮后使用系统默认应用打开。
- 支持后续手动新增资源的重复检测，重复键为同平台 MD5。
- 支持可选的资源字符串跳转功能，通过 VSCode 设置项启用。

## 使用方式

1. 打开侧边栏中的 `Image Gallery`。
2. 首次进入会执行 `Sync`，等待索引完成。
3. 使用顶部筛选框缩小范围，优先选择平台、项目、模块，再选择媒体类型和格式。
4. 使用右下角悬浮缩放按钮调整资源卡片大小。
5. 单击卡片复制资源引用；双击卡片打开并定位资源文件。
6. 点击 `i` 打开详情窗口；点击详情窗口中的刷新图标会强制重新读取该文件的 MediaInfo。
7. 音视频卡片中央播放按钮会调用系统默认播放器，不在插件内播放。

## Sync 和 Refresh

- `Sync`：日常使用。检测新增、删除、修改，并复用未变化资源的元数据缓存。
- `Refresh`：强制重建。会重新扫描并重新提取所有资源元数据，耗时明显更高。
- 如果只有某个文件信息不完整，优先打开详情窗口并点击刷新图标，不要直接全量 `Refresh`。

## 性能说明

- 插件会持久化未变化文件的元数据缓存；重启 IDE 后再次 `Sync` 会复用缓存。
- 索引过程中的进度消息会持续输出，但资源列表的 partial publish 已节流并合并到最新批次，避免 webview 频繁全量重绘。
- Web UI 会预计算搜索字段和排序结果，筛选时避免重复排序。
- 卡片使用分批渲染、`DocumentFragment` 批量追加和 CSS containment 降低滚动与筛选卡顿。

## MediaInfo

- Windows 优先尝试 `cmd /c mediaInfo --output=json <file>`。
- macOS / Linux 优先尝试 `mediainfo output=JSON <file>`，再尝试 dashed output 参数和纯文本输出。
- macOS 会额外检查 `/opt/homebrew/bin/mediainfo`、`/usr/local/bin/mediainfo`、`/opt/local/bin/mediainfo`、`/usr/bin/mediainfo`，避免 GUI 启动 IDE 时缺少 shell `PATH`。
- 只支持 MediaInfo CLI，不使用 MediaInfo GUI。

## 排查 loading 或性能问题

1. 打开 `View > Output`。
2. 选择 `Image Gallery Preview`。
3. 复制 `[sync]`、`[refresh]`、`[worker:...]` 开头的日志。
4. 同时记录 loading 面板中的 phase、count、current path、diagnostic。
