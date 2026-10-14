# 兆次元 1.0.0-beta.2 · 内置角色与多语言

本版加入两个可直接显示的 Live2D 示例角色，并支持中文、English、日本語界面。首次使用不必先寻找模型，配置自己的大语言模型后即可开始聊天。

## 更新内容

- 内置虹色 Mao、桃濑日和 Hiyori。首次安装默认使用 Mao，角色库及状态栏菜单均可切换。
- 两个角色预置全身、半身、mini 取景、视线跟随和口型。mini 是同一模型的缩小取景，不是重新绘制的 Q 版素材。
- Mao 预设原生情绪表情；日和使用官方包中的动作，不包含独立表情文件。
- 中英日界面即时切换，覆盖面板、悬浮工具栏、独立聊天和状态栏菜单；切换保留未发送的草稿。角色设定、提示词和聊天保持原文。
- 升级保留已有角色、配置和聊天，不强制切换当前角色。示例角色可以删除，重启后不会自动重建。
- 内置模型保留完整来源、版权及独立许可；安装包不包含用户角色、密钥或聊天记录。

## 安装与升级

在 [Releases](https://github.com/qian-ramiel/zhaociyuan/releases) 查看本版可用附件：

- `Zhaociyuan-1.0.0-beta.2-mac-arm64.dmg`
- `SHA256SUMS.txt`
- `MAC-INSTALL.md`

仅适用于 Apple Silicon（M 系列）Mac，最低 macOS 13，尚未覆盖所有系统和设备。安装包内置本地服务、Kokoro TTS、SenseVoice ASR 和两个示例角色，无需额外安装 Node.js、Python 或 ffmpeg。大语言模型及第三方服务仍需自行配置，不附带服务额度。

升级前备份必要数据，从状态栏退出旧应用，再将新版拖入 Applications 替换。数据目录沿用 `~/Library/Application Support/Nice People`。没有自动更新功能。

下载附件后，可在所在文件夹执行 `shasum -a 256 -c SHA256SUMS.txt`，应显示 `OK`。详细步骤见 [安装说明](https://github.com/qian-ramiel/zhaociyuan/blob/v1.0.0-beta.2/docs/release/MAC-INSTALL.md)。

## 安全与已知限制

安装包只有 ad-hoc 完整性签名，**没有 Apple Developer ID 签名与公证**。请遵循安装说明，不要全局关闭系统安全检查；若提示恶意软件、文件损坏或校验失败，请停止安装并反馈。

屏幕捕获和麦克风需按需授权，文字聊天不需要全部权限。聊天、截图或语音文本可能发送给你配置的服务商；本地优先不等于全部推理离线。详见 [隐私说明](https://github.com/qian-ramiel/zhaociyuan/blob/v1.0.0-beta.2/docs/PRIVACY.md)。

真实麦克风回声、游戏快捷键冲突、多桌面及全屏、长时间通话和不同 macOS 版本仍需进一步验证。暂不提供 Intel Mac、Windows、Linux 安装包，也不包含系统音频监听、VRM 或云同步。

## 授权与反馈

原创应用使用 Zhaociyuan License 1.0，是带商业用途限制的源码可见许可。Live2D SDK、示例角色、语音权重和其他第三方组件保留各自许可；应用许可不授予其额外权利。示例模型的使用资格与 SDK 应用发行要求应分别确认。[角色来源与条款](https://github.com/qian-ramiel/zhaociyuan/blob/v1.0.0-beta.2/resources/builtin-characters/NOTICE.md)

反馈请提供版本、芯片与系统版本、复现步骤及脱敏截图。不要附密钥、数据库或完整聊天；安全问题请使用 SECURITY.md 所述私密渠道。
