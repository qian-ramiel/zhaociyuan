# 兆次元 1.0.0-beta.1 · macOS 测试版

兆次元是一个本地优先的 AI 桌面伴侣，可导入角色形象，自行配置大语言模型与声音，通过文字、语音和授权屏幕画面互动。本版为 beta，欢迎反馈使用问题。

## 下载与安装

下载附件 `Zhaociyuan-1.0.0-beta.1-mac-arm64.dmg`，打开后将“兆次元”拖入 Applications，再从“应用程序”启动。

- 面向 Apple Silicon（M 系列）Mac，构建最低系统版本为 macOS 13，尚未覆盖所有系统版本和设备。
- 无需安装 Node.js、Python 或 ffmpeg，已内置 Kokoro TTS 和 SenseVoice ASR。
- 角色形象、LLM 及第三方服务由你自行配置；使用外部服务可能产生费用。
- [安装说明](https://github.com/qian-ramiel/zhaociyuan/blob/v1.0.0-beta.1/docs/release/MAC-INSTALL.md)也作为 `MAC-INSTALL.md` 附件提供。
- 下载校验文件 `SHA256SUMS-beta.1.txt`，在附件所在文件夹运行 `shasum -a 256 -c SHA256SUMS-beta.1.txt`，应显示 `OK`。

## 主要功能

- 桌面 Live2D / 立绘、多形象与表情动作配置。
- 独立聊天、状态栏控制、语音转写、通话与插话打断。
- 自定义 LLM / TTS、独立视觉模型和可管理的记忆与资料。
- 手动、发送消息时、定时或画面变化触发的授权截图。
- 自定义陪伴模式、提示词、默认形象与表单工作流。

## 安全与权限

当前只有 ad-hoc 完整性签名，**没有 Apple Developer ID 签名与公证**。首次打开可能受 macOS 安全设置限制，请按安装说明操作。不要全局关闭系统安全检查；若提示恶意软件或文件损坏，请停止并反馈。

录音、屏幕捕获和全局快捷键分别需要麦克风、屏幕录制和辅助功能权限。只用文字聊天不需全部授权。屏幕观察还受应用、角色和模式开关控制。

聊天、截图和语音文本可能发送到你配置的服务商；“本地优先”不代表所有推理都离线。详见 [隐私说明](https://github.com/qian-ramiel/zhaociyuan/blob/v1.0.0-beta.1/docs/PRIVACY.md)。

## 已知限制

- 暂无 Intel Mac、Windows 或 Linux 安装包，也没有自动更新。
- 真实麦克风回声、游戏快捷键冲突、多桌面、全屏和长时间通话仍需进一步验证。
- 视觉模型可能误读文本，ASR 可能识别错专有名词，不保证实时游戏策略或连续影片理解。
- 没有系统音频监听、VRM 或云同步。
- 升级前请备份必要数据，并从状态栏正常退出旧应用。数据目录为 `~/Library/Application Support/Nice People`，卸载不会自动删除配置或密钥。

## 反馈与授权

反馈请提供版本、芯片与系统版本、复现步骤、预期和实际结果，以及脱敏截图。不要附密钥、数据库或完整聊天。安全问题请按 SECURITY.md 通过私密渠道报告。

原创应用采用 Zhaociyuan License 1.0，是带商业用途限制的源码可见许可。Live2D、语音权重及其他组件保留各自授权；应用许可不替代第三方使用或发行条款。
