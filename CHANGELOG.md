# Changelog

## 0.1.8

- 修复 CCR `Router` 为数组等非法结构时无法写入的问题，补全缺失的路由绑定（`default`/`background`/`think`/`longContext`/`webSearch`），保留已有的可用绑定与 `longContextThreshold`。
- 新增配置变更后自动重启 CCR 运行时（`reloadCcrRuntimeWhenChanged`），以及检测 preset 在服务启动后被修改时按需重启（`reloadCcrRuntimeIfPresetOutdated`，通过 PID 文件与进程启动时间比对）。
- 删除 profile 时对 Windows 文件锁（`EBUSY`/`EACCES`/`ENOTEMPTY`/`EPERM`）增加重试，失败时给出可读的错误提示。
- `CcpError` 支持 `cause` 选项以保留错误链。

## 0.1.7

- 添加会话同步可视化 UI。

## 0.1.6

- 支持通过预设模板自动配置 CCR provider。

## 0.1.5

- 添加终端启动和设置文件位置显示功能。
- 将预设描述从英文翻译为简体中文。

## 0.1.4

- 添加本地 Web UI 管理界面。
- 添加预设模板和交互式创建界面。

## 0.1.3

- 将模型名称设为可选，留空则使用 Claude Code 默认模型。

## 0.1.2

- 添加会话同步功能。
- 在创建配置前检查是否已存在同名配置。
- 从 `package.json` 读取版本号而非硬编码。
- 移除未使用的环境变量配置。

## 0.1.1

- 实现 CCR 配置文件和预设管理功能。

## 0.1.0

- Initial TypeScript npm package scaffold.
- Added cross-platform profile core for API and Claude login profiles.
- Added CLI commands for `list`, `add`, `add-login`, `remove`, `status`, `path`, `edit`, and `start`.
- Added Vitest coverage for core profile behavior.
- Added CCR base commands for `status`, `install`, `start`, `stop`, `restart`, `ui`, and `model`.
- Added CCR preset-bound profile creation with `add-ccr`.
- Added CCR profile gateway preparation before `ccp start`.
- Added session synchronization with `sync-session`.
