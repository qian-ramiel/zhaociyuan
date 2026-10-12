# 兆次元 1.0 macOS 本地验收安装版

## 安装

本次构建为 Apple Silicon（M 系列）专用，不支持 Intel Mac。打开 DMG，把“兆次元”拖到 Applications，再从应用程序打开。无需安装 Node.js、Python 或系统 ffmpeg。

这是本地验收构建，使用 ad-hoc 签名，没有 Apple Developer ID 签名和公证。不要当作正式公开发行包。若 macOS 阻止首次打开，确认来源后可在“系统设置 → 隐私与安全性”使用“仍要打开”；不要全局关闭系统安全检查。

安装版首次使用不包含开发版的角色、密钥、聊天或知识库。请创建角色，导入你有使用权的形象，并配置自己的模型服务。需要时可在开发版导出角色包，再在安装版导入。

## 权限与数据

- 录音需要麦克风权限，屏幕观察需要屏幕录制权限，双 Shift 按住说话需要辅助功能权限。安装版需单独授权，开发版的 Electron 授权不会自动继承。
- 安装版沿用 bundle ID `org.nicepeople.companion` 和用户目录 `~/Library/Application Support/Nice People`，不删除已有安装版数据。
- 数据保存在用户目录中，不写入 `.app` 或 DMG。卸载应用不会自动删除聊天、角色或密钥。
- 本地服务只监听 `127.0.0.1`，自动选择空闲端口，通过每次启动生成的随机口令连接；退出时关闭服务。
- 启动故障记录为用户数据目录中的 `startup.log`，不记录请求正文。模型调用记录仍从面板查看。

## 内置资源

内置本地服务、SenseVoice int8 识别模型与 Kokoro 中文语音模型，第三方 TTS 可自行配置。模型只读使用；用户自己安装的同名本地模型优先。没有把私人 Live2D 角色或开发数据库放入安装包。

应用图标使用内置图片生成工具将已选定 Logo 制作为白色圆角 macOS 图标，并转换成包含 16–1024px 的 ICNS。原 Logo 与状态栏图标保持不变，状态栏不显示名称文字。

## 公开发行前仍需完成

1. Apple Developer ID 签名、公证与公证票据装订，以及不同 macOS 版本上的首次安装验收。
2. Live2D Core 的具体发行条款确认；项目许可不取代 Live2D 的许可。
3. 精确核验内置语音模型、espeak-ng 数据、ffmpeg、libuiohook 原生库及其他依赖的再分发义务。安装包已收集现有许可、版本清单、模型哈希和 uiohook 源码，不表示法律审查已完成。
4. Intel 版本需独立准备 x86_64 服务与原生依赖，不能把 arm64 包改名冒充通用版本。

资源许可在 `.app/Contents/Resources/licenses`；Electron 自身许可随框架保留。

## 构建

开发机先安装项目依赖、本地语音模型和 `tools/packaging/requirements.txt` 中的打包依赖，再执行 `npm run package:mac`。产物放在 `releases`。构建不会上传发布，也不会自动安装或覆盖运行中的应用。

参考：[PyInstaller macOS 原生架构与签名](https://pyinstaller.org/en/stable/feature-notes.html)、[electron-builder 26 macOS 配置](https://www.electron.build/v26/docs/mac/)。
