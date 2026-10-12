# 兆次元 1.0.0-beta.1 macOS 测试版安装说明

## 下载与适用设备

本版面向 **Apple Silicon（M 系列）Mac**，构建最低系统版本为 macOS 13，尚未覆盖所有系统版本和设备。不支持 Intel、Windows 或 Linux。

安装包暂未提供公开下载。本文说明安装步骤和源码构建方法；安装包发布后，可从 [Releases](https://github.com/qian-ramiel/zhaociyuan/releases) 下载以下附件：

- `Zhaociyuan-1.0.0-beta.1-mac-arm64.dmg`：安装包。
- `SHA256SUMS-beta.1.txt`：SHA-256 校验文件。
- `MAC-INSTALL.md`：本说明。

## 安装

1. 需要时先备份已有角色配置及用户数据；从旧安装版升级不会自动清空数据。
2. 打开 DMG，把“兆次元”拖入 Applications；不要直接从 DMG 中长期运行。
3. 如需替换已有应用，请先从状态栏选择“退出”，仅关面板不等于退出。
4. 从“应用程序”打开“兆次元”，完成首次角色和服务配置。

无需安装 Node.js、Python 或系统 ffmpeg。安装包内置本地服务、SenseVoice int8 语音识别和 Kokoro 语音合成模型。角色形象、LLM 及第三方 TTS 由你自行配置；外部服务可能产生费用。

## 首次打开的安全提示

这是 **未完成 Apple Developer ID 签名及公证的测试包**，只有 ad-hoc 完整性签名。它不等于 Apple 认可的开发者签名或安全审查。

如果系统提示无法验证开发者，在确认下载来源与校验值后，可按 [Apple 官方说明](https://support.apple.com/zh-cn/102445)，先尝试打开应用，再到“系统设置 → 隐私与安全性”查看“仍要打开”。

不要全局关闭门禁或 SIP。若系统明确提示恶意软件、文件已损坏，或没有“仍要打开”，停止安装并反馈，勿强行绕过。当前未完成真实浏览器下载隔离属性下的 Gatekeeper 验收，不保证这一路径在所有设备都可用。

可选校验：把安装包和校验文件放在同一文件夹，再在该文件夹运行：

```bash
shasum -a 256 -c SHA256SUMS-beta.1.txt
```

应显示安装包文件名后跟 `OK`。校验失败时不要安装，重新从 Release 下载并联系维护者。

## 首次配置

1. 创建角色，导入你有使用权的 Live2D ZIP 或静态立绘。
2. 在角色配置的“思维”中填写 LLM 地址、模型名称和自己的 Key，保存并测试。
3. 在“声音”选择本地 Kokoro 或自己的 TTS 服务，再选择语音识别设置。
4. 设置陪伴模式与提示词；需要看屏幕时另行打开视觉和模式授权。使用支持图片的对话模型，或配置独立视觉模型。

本地语音可用不代表已连接大语言模型。聊天需要配置 LLM；基础的本地形象切换可独立使用。mini 需要自行绑定形象，不会自动生成 Q 版素材。

## 权限与数据

- 麦克风权限用于录音；屏幕录制权限用于已授权的画面捕获；辅助功能权限用于双 Shift 等全局按住说话快捷键。只使用文字聊天时不需要全部授予。
- 在“系统设置 → 隐私与安全性”授权“兆次元”。安装版需要单独授权，开发版 Electron 的权限不会自动继承。必要时退出后重新打开。
- 听觉控制麦克风，不是系统声音监听。关闭视觉后，文字或语音发送不应再附图；先选择非敏感窗口验证。
- bundle ID 沿用 `org.nicepeople.companion`，用户数据目录沿用 `~/Library/Application Support/Nice People`，不删除已有安装版数据。
- 密钥优先保存到系统钥匙串，不可用时可能退回明文 `secrets.json`；见 [隐私说明](https://github.com/qian-ramiel/zhaociyuan/blob/main/docs/PRIVACY.md)。
- 数据不写入应用或 DMG。卸载不会自动删除数据或钥匙串密钥；导出的角色包也可能包含个人设定或用户选择的历史，勿直接公开。
- 本地服务只监听 `127.0.0.1`，通过每次启动生成的随机口令连接；正常退出时关闭。不要暴露到公网。
- 启动故障记录为用户目录中的 `startup.log`。反馈前检查日志内容，不上传数据库、密钥或完整聊天。

## 测试建议和已知限制

先用非敏感内容验证创建角色、文字回复、TTS 试听、录音转写、浮动聊天、拖动缩放、切换模式与退出。再逐项授权并验证屏幕捕获和按住说话；不要一开始就打开敏感窗口或使用昂贵模型。

真实麦克风噪声 / 回声、游戏内双 Shift 冲突、多桌面 / 全屏、长时间通话、不同模型厂商、不同 macOS 版本还需要更多测试。视觉模型可能误读文本；不保证实时游戏策略或连续影片理解。没有系统音频监听、VRM、云同步或自动更新；升级需要手动下载新包。

反馈请附版本、芯片与系统版本、复现步骤、预期和实际结果，以及脱敏截图。安全问题请走 [SECURITY.md](https://github.com/qian-ramiel/zhaociyuan/blob/main/SECURITY.md) 所述私密渠道。

## 版权与发行边界

原创应用使用 Zhaociyuan License 1.0；Live2D、语音权重和其他第三方组件保留原授权。版权资料在 `.app/Contents/Resources/licenses`，Electron 框架许可另行保留。

应用许可不授予第三方组件的额外权利。使用、修改或再分发 SDK、语音模型及原生库时，应遵循其各自条款；第三方文件随附的版权声明应保留。

## 开发者构建

先安装项目依赖，使用 Python 3.12.15 或更新的 3.12 补丁版创建服务环境，再安装本地语音模型和 `tools/packaging/requirements.txt` 中的打包依赖，最后执行 `npm run package:mac`。产物在 `releases/`，默认不上传发布，也不会自动安装或覆盖运行中的应用。

打包默认使用 `.venv/bin/python`。需要隔离构建环境时，可设置 `NICE_PEOPLE_PYTHON` 为已安装上述依赖的 Python 3.12 环境中解释器的绝对路径；已安装的应用仍使用包内服务，不依赖该环境变量或系统 Python。

参考：[PyInstaller macOS 打包](https://pyinstaller.org/en/stable/feature-notes.html)、[electron-builder macOS 配置](https://www.electron.build/v26/docs/mac/)。
