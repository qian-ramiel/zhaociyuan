# 开发说明

## 项目结构

| 目录 | 内容 |
| --- | --- |
| apps/desktop | Electron 主进程、桌面窗口及 React / Vite 界面 |
| services/companion | FastAPI 本地服务、SQLite、模型与语音适配 |
| tests/desktop | 桌面单元测试及隔离 UI / 安装包测试工具 |
| tools | 开发启动、依赖准备、打包与上传检查 |
| build/packaging | 应用图标和 macOS 权限配置 |
| docs | 当前开发、隐私、授权和安装说明 |
| resources/builtin-characters | 官方 Mao / Hiyori 示例角色、运行文件校验清单及独立授权 |
| resources/characters、speech、knowledge | 用户素材和下载权重，仅保留目录占位，不提交实际资源 |
| runtime | 本地数据和测试证据，仅保留目录占位 |

运行数据、下载权重、测试截图和构建产物不进入源码提交。

内置角色只从 `resources/builtin-characters/manifest.json` 的校验清单进入安装包，不复制用户角色目录。首次运行创建两个示例角色，默认使用 Mao；已有用户不切换当前角色、不改配置，删除的示例不会在重启后重新出现。全身、半身、mini 是同一模型的取景预设，不是额外绘制的 Q 版素材。需要恢复原始资源时，先阅读并同意随附的 Live2D 条款，再执行 `python3 tools/setup_characters.py`，脚本校验官方压缩包摘要并只提取运行资源。

本地服务使用 Python 3.12.15 或更新的 3.12 补丁版。安装后执行 `npm run setup:api` 创建 `.venv`；也可使用 `python3.12 tools/setup_api.py`。已有旧版 Python 虚拟环境时，先正常退出开发服务，将旧 `.venv` 改名保留，再创建新环境；不要删除 `runtime/` 或用户应用数据。安装脚本不会覆盖不兼容的已有环境。

## 验证

```bash
npm run build
npm test
npm run check:publish
```

单元测试不代替真实麦克风、屏幕权限、游戏操作或长期体验验收。`test:desktop`、`test:feedback` 和安装包测试可能创建窗口，应在专门的测试环境运行，勿干扰实际工作或已有会话。

安装包测试使用隔离用户目录，覆盖服务启动、访问鉴权、本地语音、窗口和退出。它不代替多设备、真实麦克风、游戏快捷键或网络下载后的 Gatekeeper 验收。

## 构建 macOS

参见 [安装与构建说明](release/MAC-INSTALL.md)。需要 Apple Silicon Mac、本地语音资源及 PyInstaller 打包依赖；`npm run package:mac` 只生成安装包，不自动上传。构建产物在 `releases/`，不进入源码提交。

## 上传前检查

`npm run check:publish` 检查 Git 已跟踪文件与未忽略候选文件，不读取钥匙串或个人运行目录。它检查常见凭据格式、危险文件、私有路径和大文件；无法证明不存在所有秘密，也不能代替人工检查图片与未知格式。

请再使用 Gitleaks 等独立扫描器检查即将上传的文件及 Git 历史。不能只把泄露值替换成星号后继续保留历史；已经离开本机的真实凭据需要先撤销或轮换。

本仓库没有示例真实 Key，也不要求提交 .env。密钥通过应用设置配置。源码中的 apiKey 等字段是功能接口，不应删除；测试用占位值不是可用凭据。
