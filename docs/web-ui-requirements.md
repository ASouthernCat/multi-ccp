# Web UI 需求文档

`src/web` 用于实现 `multi-ccp` 的本地 Web UI，可视化管理 Claude Code Profiles、配置状态和会话同步流程。

该 Web UI 是 CLI 的辅助界面，不替代 CLI，也不引入新的配置体系。它应尽量复用现有 `src/core` 中的 Profile、Settings、Sessions、CCR 等逻辑，保证 Web 行为与 CLI 行为一致。

## 1. 产品定位

`ccp ui` 是一个运行在本机的轻量 Web 管理界面，主要用于：

- 展示简单的整体统计信息；
- 通过卡片或列表总览所有 Profile 配置；
- 快速创建 API / Login / CCR Profile；
- 查看每个 Profile 的状态和详细信息；
- 编辑 Profile 配置；
- 删除 Profile；
- 查看 Claude Code Router 状态；
- 启动 / 重启 / 停止 Claude Code Router；
- 打开 Claude Code Router 自带 UI；
- 提供方便、直观、可视化的会话同步管理。

## 2. 范围边界

### 2.1 ccp ui 负责

- `multi-ccp` Profile 管理；
- API Profile 创建、查看、编辑、删除；
- Login Profile 创建、查看、删除；
- CCR Profile 创建、查看、编辑绑定信息、删除；
- Profile 状态检测和详情展示；
- Profile 配置编辑；
- 会话同步扫描、差异展示、选择同步、冲突确认；
- CCR 状态查看；
- CCR 启动、重启、停止快捷操作；
- 打开 CCR UI 的快捷入口；
- 操作结果和错误信息展示。

### 2.2 ccp ui 不负责

- 不管理 CCR 的 provider 配置；
- 不管理 CCR 的 model 配置；
- 不管理 CCR 的 route / transformer / preset 细节；
- 不替代 Claude Code Router 自带 UI；
- 不实现远程多用户管理后台；
- 不引入独立于 CLI 的 Profile 配置格式。

CCR 在 `ccp ui` 中的定位是：

> 只提供状态查看、服务控制和打开 CCR UI 的快捷入口。具体 CCR 配置由 CCR 自带 UI 管理。

## 3. 技术约束

### 3.1 前端约束

不使用前端框架，包括但不限于：

- Vue；
- React；
- Angular；
- Svelte；
- Solid；
- Next.js；
- Nuxt；
- Remix。

允许使用：

- 原生 HTML；
- 原生 CSS；
- 原生 JavaScript / TypeScript；
- Web Components，可选；
- CSS Variables；
- `fetch`；
- `EventSource` 或 WebSocket，用于实时状态和日志；
- `lucide` 等第三方图标库；
- 少量明确有价值的轻量工具库。

初期应避免：

- 重型 UI 组件库；
- 复杂前端构建体系；
- Monaco / CodeMirror 这类大型编辑器，除非后续确实需要 Raw JSON 编辑能力。

### 3.2 服务端约束

- 默认仅监听 `127.0.0.1`；
- 默认不暴露到局域网或公网；
- 所有写操作应有本地 token 或等效机制保护；
- 所有 Profile 文件操作应复用或对齐 CLI/core 逻辑；
- 敏感信息默认脱敏。

## 4. 命令入口

建议增加命令：

```bash
ccp ui
```

可选参数：

```bash
ccp ui --host 127.0.0.1
ccp ui --port 7821
ccp ui --open
```

默认行为：

- 监听 `127.0.0.1`；
- 使用固定默认端口，例如 `7821`；
- 在终端输出访问地址；
- 如果指定 `--open`，启动后自动打开浏览器。

## 5. 布局设计

`ccp ui` 不采用传统的“侧边栏导航 + 主内容区”后台布局，而采用 **分组式 Profile 工作台布局**。

核心思路：

> 页面围绕不同 Profile 展开。用户首先看到所有 Profile，再围绕某个 Profile 查看详情、编辑配置、删除、复制启动命令或发起会话同步。

主界面由以下区域组成：

```text
Top Summary Bar
Profile Toolbar
Grouped Profile Board
Profile Details Drawer
Sync Workspace
CCR Panel
Activity / Logs
```

整体布局示例：

```text
┌──────────────────────────────────────────────────────────────┐
│ Top Summary Bar                                              │
│ multi-ccp                                                    │
│ Profiles 8 · API 4 · Login 2 · CCR 2 · CCR Running           │
│ [+ New Profile] [Sync Sessions] [CCR: Running] [Refresh]     │
├──────────────────────────────────────────────────────────────┤
│ Profile Toolbar                                              │
│ Search...       [All] [API] [Login] [CCR] [Need Attention]   │
│ View: [Cards] [List]                                         │
├──────────────────────────────────────┬───────────────────────┤
│ Grouped Profile Board                │ Profile Details Drawer │
│                                      │                       │
│ Main                                 │ selected profile       │
│ ┌──────────────┐                     │ details / edit / sync  │
│ │ main         │                     │ actions                │
│ └──────────────┘                     │                       │
│                                      │                       │
│ API Profiles                         │                       │
│ ┌──────────────┐ ┌──────────────┐    │                       │
│ │ deepseek     │ │ openrouter   │    │                       │
│ └──────────────┘ └──────────────┘    │                       │
│                                      │                       │
│ Login Profiles                       │                       │
│ ┌──────────────┐ ┌──────────────┐    │                       │
│ │ work         │ │ personal     │    │                       │
│ └──────────────┘ └──────────────┘    │                       │
│                                      │                       │
│ CCR Profiles                         │                       │
│ ┌──────────────┐ ┌──────────────┐    │                       │
│ │ gpt-route    │ │ gemini-route │    │                       │
│ └──────────────┘ └──────────────┘    │                       │
└──────────────────────────────────────┴───────────────────────┘
```

### 5.1 顶部统计栏

顶部统计栏展示全局状态和常用操作。

展示内容：

- Profile 总数；
- API / Login / CCR Profile 数量；
- CCR 当前状态；
- 需要关注的 Profile 数量，可选；
- 最近操作摘要，可选。

常用操作：

- `+ New Profile`；
- `Sync Sessions`；
- `CCR: Running / Offline` 状态按钮；
- `Refresh`。

### 5.2 Profile 工具条

Profile 工具条用于快速定位配置。

功能：

- Profile 名称搜索；
- 类型过滤：`All`、`Main`、`API`、`Login`、`CCR`；
- 状态过滤：`Ready`、`Need Attention`、`Invalid` 等；
- 卡片视图 / 列表视图切换。

### 5.3 分组式 Profile Board

Profile Board 按类型分组展示所有 Profile。

推荐分组顺序：

```text
Main
API Profiles
Login Profiles
CCR Profiles
Unknown / Invalid
```

没有内容的分组可以隐藏，也可以显示轻量空状态和创建入口。

分组标题应展示数量和状态摘要，例如：

```text
API Profiles  4
3 Ready · 1 Need Attention
```

### 5.4 Profile 详情抽屉

点击卡片或列表项后，在右侧打开 Profile Details Drawer。

详情抽屉不是导航栏，而是当前 Profile 的上下文操作区。

抽屉内可使用局部 Tab：

```text
Overview
Settings
Sessions
Danger Zone
```

用途：

- `Overview`：展示状态、路径、配置摘要、启动命令；
- `Settings`：表单编辑 Profile 配置；
- `Sessions`：将当前 Profile 设为同步来源或目标；
- `Danger Zone`：删除 Profile 等危险操作。

小屏幕下，详情抽屉可以退化为全屏详情面板。

### 5.5 Sync Workspace

会话同步作为独立的 Sync Workspace 打开，可以是全屏 Modal 或覆盖式工作区。

进入方式：

- 顶部 `Sync Sessions`；
- Profile 卡片上的 `Sync`；
- Profile 详情抽屉中的 `Use as Sync Source` / `Use as Sync Target`。

当某个 Profile 被选为同步来源或目标时，Profile Board 中对应卡片可以显示临时标签：

```text
[Sync Source]
[Sync Target]
```

### 5.6 CCR Panel

CCR 不作为完整配置管理页面，而是作为服务状态面板。

进入方式：

- 顶部 CCR 状态按钮；
- CCR Profile 卡片；
- Profile 详情抽屉中的 CCR 相关入口。

CCR Panel 只提供：

- CCR 状态；
- Start / Restart / Stop；
- Open CCR UI；
- 使用 CCR 的 Profile 数量；
- 提示 CCR 具体配置由 CCR UI 管理。

### 5.7 Activity / Logs

Activity / Logs 可以作为底部抽屉、弹窗或可折叠面板，不作为主要导航页面。

用于展示当前 Web 会话内的操作记录和错误信息。

## 6. Dashboard 首页

### 6.1 目标

用户打开 Web UI 后，应能快速了解当前 `multi-ccp` 环境的整体状态。

### 6.2 统计信息

Dashboard 应展示简单统计卡片：

- Profile 总数；
- API Profile 数量；
- Login Profile 数量；
- CCR Profile 数量；
- CCR 运行状态；
- 最近操作数量或最近操作摘要，可选。

示例：

```text
Profiles: 8
API: 4
Login: 2
CCR: 2
CCR Status: Running
```

### 6.3 快捷入口

Dashboard 应提供常用快捷操作：

- 新建 API Profile；
- 新建 Login Profile；
- 新建 CCR Profile；
- 进入 Profile 总览；
- 开始会话同步；
- 刷新 CCR 状态；
- 启动 / 重启 CCR；
- 打开 CCR UI。

## 7. Profiles 页面

Profiles 页面是 `ccp ui` 的核心页面。

### 7.1 目标

通过卡片或列表方式总览所有配置，并提供常用管理操作。

### 7.2 视图模式

应支持至少一种总览方式，推荐同时支持：

- 卡片视图；
- 列表视图。

卡片视图适合配置较少时快速浏览；列表视图适合配置较多时批量查看。

### 7.3 Profile 字段

每个 Profile 至少展示：

- 名称；
- 类型：
  - `main`；
  - `api`；
  - `login`；
  - `ccr`；
  - `unknown`；
- 状态：
  - `Ready`；
  - `Missing settings`；
  - `Invalid settings`；
  - `Missing directory`；
  - `CCR unavailable`；
  - `Unknown`；
- 当前模型；
- Base URL，API Profile 显示；
- CCR endpoint / route / preset，CCR Profile 显示；
- Profile 路径；
- 最近修改时间；
- 是否存在 `settings.json`；
- 是否存在 `.ccp.json`。

### 7.4 Profile 操作

每个 Profile 应提供：

- 查看详情；
- 编辑配置；
- 删除配置；
- 复制路径；
- 复制启动命令；
- 打开目录，可选；
- 作为会话同步来源；
- 作为会话同步目标。

### 7.5 启动命令

第一版建议以复制命令为主，不强制实现直接启动终端。

例如：

```bash
ccp start work
```

可以支持填写附加 Claude Code 参数后生成命令，例如：

```bash
ccp start work --dangerously-skip-permissions
```

直接从 Web UI 启动交互式 Claude Code 终端可作为后续增强功能。

## 8. 快速创建 Profile

页面应提供明显的入口：

```text
+ New Profile
```

点击后选择预设模板或自定义配置：

- API preset；
- CCR preset；
- Custom API；
- Manual CCR；
- Claude Login。

对应 CLI 主入口：

```bash
ccp add [profile]
ccp add --preset <preset> [profile]
```

### 8.1 创建 API Profile

对应 CLI：

```bash
ccp add
ccp add --preset deepseek [profile]
```

表单字段：

- Profile 名称；
- `ANTHROPIC_BASE_URL`；
- `ANTHROPIC_AUTH_TOKEN`；
- Model，可选。

校验要求：

- Profile 名称不能为空；
- Profile 名称不能与已有 Profile 冲突；
- Profile 名称必须拒绝路径穿越；
- Base URL 应为合法 URL；
- Model 可以为空，表示使用 Claude Code 默认模型。

后续可增加高级模型配置：

- `ANTHROPIC_MODEL`；
- `ANTHROPIC_DEFAULT_OPUS_MODEL`；
- `ANTHROPIC_DEFAULT_SONNET_MODEL`；
- `ANTHROPIC_DEFAULT_HAIKU_MODEL`；
- `CLAUDE_CODE_SUBAGENT_MODEL`。

### 8.2 创建 Login Profile

对应 CLI：

```bash
ccp add
ccp add-login <profile>
```

表单字段：

- Profile 名称。

页面说明：

> Login Profile 不保存 Claude 账号密码，只隔离 Claude Code 的登录状态。

创建完成后提示用户复制启动命令：

```bash
ccp start <profile>
```

### 8.3 创建 CCR Profile

对应 CLI：

```bash
ccp add
ccp add --preset ccr-gpt [profile]
ccp add-ccr <profile>
```

表单字段：

- Profile 名称；
- CCR preset / route 名称。

如果可以从 CCR 获取 preset 列表，可以提供下拉选择；如果不能，应允许手动输入。

页面应展示 endpoint 预览，例如：

```text
http://127.0.0.1:3456/preset/<preset>
```

创建后提示：

> 具体 CCR provider、model、route 配置请在 Claude Code Router UI 中修改。

并提供：

- 打开 CCR UI；
- 复制 CCR UI 命令；
- 查看 CCR 状态。

## 9. Profile 详情页

### 9.1 基本信息

详情页应展示：

- Profile 名称；
- Profile 类型；
- Profile 路径；
- 配置文件路径；
- `.ccp.json` 路径，如果存在；
- 创建 / 修改时间，可获取时展示；
- 是否可启动；
- 当前状态和状态说明。

### 9.2 配置摘要

API Profile 应展示：

- Base URL；
- Model；
- Opus Model；
- Sonnet Model；
- Haiku Model；
- Subagent Model；
- Token 是否已配置。

Token 默认只展示配置状态或脱敏值，例如：

```text
Configured
sk-****abcd
```

Login Profile 应展示：

- 是否存在 settings；
- 是否设置 API token；
- 是否疑似存在登录状态；
- 推荐启动命令。

CCR Profile 应展示：

- CCR endpoint；
- CCR preset / route 名称；
- CCR 服务状态；
- 打开 CCR UI 的入口；
- 说明 CCR 具体配置由 CCR UI 管理。

## 10. 编辑 Profile 配置

编辑功能是核心能力之一。

### 10.1 编辑方式

第一版建议使用表单编辑，而不是直接提供 Raw JSON 编辑器。

### 10.2 API Profile 编辑

可编辑字段：

- Base URL；
- Auth Token；
- Model；
- Opus Model；
- Sonnet Model；
- Haiku Model；
- Subagent Model。

Token 处理规则：

- Token 字段默认不显示完整 token；
- 如果用户不填写新 token，则保留原 token；
- 如果用户填写新 token，则覆盖原 token；
- 保存前应明确提示会更新敏感配置。

### 10.3 Login Profile 编辑

Login Profile 通常不编辑 API token 或 Base URL。

第一版可以只提供：

- 只读详情；
- 删除；
- 复制启动命令；
- 打开路径。

后续如支持 profile metadata，可再加入编辑能力。

### 10.4 CCR Profile 编辑

只编辑 `multi-ccp` 侧的绑定信息，不编辑 CCR 内部配置。

可编辑字段：

- CCR preset / route 名称；
- CCR endpoint 绑定信息。

必须提示：

> CCR 的 provider、model、route 等具体配置请在 CCR UI 中修改。

### 10.5 Raw JSON 编辑

Raw JSON 编辑可以作为高级功能，不作为第一优先级。

如果实现，必须满足：

- 默认折叠；
- 明确警告；
- 保存前校验 JSON；
- 保存前备份；
- 敏感字段清晰处理；
- 保存失败时不能破坏原配置。

## 11. 删除 Profile

删除功能必须安全。

要求：

- 不允许删除 `main`；
- 删除前展示 Profile 名称和路径；
- 用户必须输入 Profile 名称确认；
- 删除成功后刷新列表；
- 删除失败时展示原因；
- 删除操作记录到 Activity / Logs。

确认示例：

```text
Delete profile "work"?

This will remove:
~/.claude-profiles/work

Type "work" to confirm.
```

## 12. CCR 页面

### 12.1 目标

提供 Claude Code Router 的状态查看和服务快捷操作，不管理 CCR 的内部配置。

### 12.2 展示内容

CCR 页面应展示：

- CCR 是否安装；
- CCR 是否运行；
- CCR 服务地址；
- CCR UI 地址；
- `ccp ccr status` 输出摘要；
- 使用 CCR 的 Profile 数量；
- 最近一次启动 / 重启 / 停止操作结果。

### 12.3 操作

支持：

- Refresh Status；
- Start CCR；
- Restart CCR；
- Stop CCR，可选；
- Open CCR UI；
- Copy CCR UI Command；
- Copy CCR Status Command。

对应命令：

```bash
ccp ccr status
ccp ccr start
ccp ccr restart
ccp ccr stop
ccp ccr ui
```

### 12.4 明确不做

CCR 页面不提供：

- provider 编辑；
- model 编辑；
- route 编辑；
- transformer 编辑；
- preset 细节管理。

页面应展示说明：

> CCR provider、model、route 配置由 Claude Code Router UI 管理。

## 13. 会话同步

会话同步是 `ccp ui` 的重点功能，要求方便操作并具备可视化管理能力。

对应 CLI：

```bash
ccp sync-session <target-profile> [--all]
ccp sync-session <source-profile|main> to <target-profile|main> [--all]
```

### 13.1 同步流程

建议设计为四步：

```text
1. 选择来源和目标
2. 扫描会话
3. 查看差异并选择
4. 执行同步并展示结果
```

### 13.2 选择来源和目标

界面：

```text
Source Profile: [main v]
Target Profile: [work v]

[Swap] [Scan Sessions]
```

要求：

- Source 和 Target 不能相同；
- `main` 可以作为 source 或 target；
- 支持一键交换 source / target；
- 可从 Profile 卡片直接进入并预选 source 或 target。

### 13.3 扫描结果统计

扫描后展示：

- 新会话数量；
- 已同步数量；
- 冲突数量；
- 缺失资源数量；
- 无法判断数量；
- 可同步总数。

示例：

```text
New sessions: 12
Already synced: 35
Conflicts: 2
Missing assets: 1
Unknown: 0
```

### 13.4 差异列表

使用表格或列表展示每个 session：

```text
[ ] Session ID         Updated       Status         Action
[ ] 2026-06-08-abc     10:32         New            Sync
[ ] 2026-06-07-def     21:15         Synced         Skip
[ ] 2026-06-06-ghi     19:44         Conflict       Review
[ ] 2026-06-05-jkl     11:20         Missing Asset  Warning
```

状态分类：

- `New`：目标中不存在，建议同步；
- `Synced`：已经同步，默认跳过；
- `Conflict`：目标中存在但内容不同；
- `Missing Asset`：资源缺失；
- `Unknown`：无法判断。

### 13.5 快捷操作

为提升操作便利性，应提供：

- Select all new；
- Select none；
- Select conflicts；
- Skip conflicts；
- Sync selected；
- Sync all new；
- Copy CLI command；
- Scan again。

### 13.6 冲突处理

冲突不能默认覆盖。

对 Conflict 项，应支持：

- 查看 source session 信息；
- 查看 target session 信息；
- 显示 source hash；
- 显示 target hash；
- 显示修改时间；
- 选择跳过；
- 显式选择覆盖。

如果同步包含冲突覆盖，必须更强确认。

示例：

```text
This will overwrite 2 conflicting sessions.
Type "overwrite" to confirm.
```

### 13.7 同步确认

同步前展示确认摘要：

```text
Source: main
Target: work

New sessions to sync: 12
Conflicts to overwrite: 0
Skipped: 35

[Cancel] [Sync]
```

### 13.8 同步结果

同步完成后展示：

- 成功同步数量；
- 跳过数量；
- 冲突跳过数量；
- 覆盖数量；
- 失败数量；
- 失败原因；
- 再次扫描按钮。

示例：

```text
Sync completed

Synced: 12
Skipped: 35
Conflicts skipped: 2
Overwritten: 0
Failed: 0
```

## 14. Activity / Logs

Web UI 应提供轻量操作记录。

记录内容：

- 创建 Profile；
- 编辑 Profile；
- 删除 Profile；
- 查看 / 刷新状态；
- 扫描 Session；
- 同步 Session；
- 启动 / 重启 / 停止 CCR；
- 错误信息。

MVP 中日志可以只保存在当前 Web server 生命周期内，不要求持久化。

日志中必须脱敏：

- API token；
- Authorization header；
- Bearer token；
- Cookie；
- 其他疑似密钥字段。

## 15. 本地 API 草案

具体实现可以调整，但建议围绕以下 API 组织。

### 15.1 Dashboard

```http
GET /api/dashboard
```

示例响应：

```json
{
  "profiles": {
    "total": 6,
    "api": 3,
    "login": 1,
    "ccr": 2
  },
  "ccr": {
    "installed": true,
    "running": true,
    "uiUrl": "http://127.0.0.1:3456"
  }
}
```

### 15.2 Profiles

```http
GET /api/profiles
GET /api/profiles/:name
POST /api/profiles/api
POST /api/profiles/login
POST /api/profiles/ccr
PUT /api/profiles/:name
DELETE /api/profiles/:name
```

### 15.3 Profile Settings

```http
GET /api/profiles/:name/settings
PUT /api/profiles/:name/settings
```

### 15.4 Sessions

```http
POST /api/sessions/scan
POST /api/sessions/sync
```

### 15.5 CCR

```http
GET /api/ccr/status
POST /api/ccr/start
POST /api/ccr/restart
POST /api/ccr/stop
GET /api/ccr/ui
```

`GET /api/ccr/ui` 可返回 CCR UI 地址，由前端打开。

## 16. 安全要求

- 默认只监听 `127.0.0.1`；
- 不应默认监听 `0.0.0.0`；
- 写操作需要本地随机 token 或等效保护；
- Profile name 必须严格校验；
- 防止路径穿越；
- API 响应默认不返回完整 token；
- UI 默认不展示完整 token；
- 日志必须脱敏；
- 删除 Profile 必须二次确认；
- 覆盖冲突 session 必须二次确认；
- CCR install / start / restart / stop 等服务操作应有明确反馈；
- 所有文件写入失败必须展示错误，不应静默失败。

建议写操作请求头：

```http
X-CCP-Web-Token: <token>
```

## 17. UI 风格要求

UI 应简洁、清晰、偏本地开发工具风格，但不能停留在普通后台管理页面或模板化 AI 工具界面。

设计目标：

- 参考 Awwwards、优秀独立开发工具官网、现代设计型 SaaS 控制台的审美；
- 拒绝明显的“AI 生成感”、模板感和默认组件库味道；
- 让界面具备清晰的信息层级、克制的动效、精致的排版和可识别的品牌气质；
- 在保证工具效率的前提下，让用户愿意长期打开和使用该界面。

视觉方向建议：

- 以深色主题为主，但避免纯黑背景，可使用带轻微色相的深灰、炭黑、墨蓝或暖黑；
- 使用大面积留白和分区层次，而不是密集堆叠表单；
- 卡片应有明确的质感，例如细边框、微弱渐变、柔和阴影或玻璃拟态，但避免过度装饰；
- 标签、状态点、按钮和输入框应形成统一视觉语言；
- 关键状态可以使用高质量色彩系统，而不是默认红黄绿；
- 图标只作为辅助，不用图标堆砌制造复杂感；
- 动效要克制，例如抽屉滑入、卡片 hover、状态刷新、Toast 出现，不做夸张动画；
- 页面应有“设计完成度”，而不是只把 API 数据渲染成表格。

交互气质：

- 首页直接呈现 Profile 工作台，减少管理后台式跳转；
- 操作路径短，但危险操作要有明确停顿；
- 空状态、错误状态和加载状态都需要精心设计；
- 文案应简洁、有温度，不使用生硬的占位式提示；
- Profile 卡片应像“可操作的配置对象”，而不是普通数据行。

设计验收标准：

- 第一眼能看出这是一个有设计意识的本地开发工具，而不是默认 HTML 表单；
- 卡片、标签、抽屉、同步工作区之间视觉语言一致；
- 即使没有大量 Profile，页面也不显得空洞；
- Profile 很多时，搜索、筛选和列表视图仍保持清晰；
- 不依赖 Vue / React 等前端框架，也不依赖重型组件库来获得设计效果；
- CSS 应作为产品体验的一部分认真设计，而不是最后补样式。

建议：

- 暗色主题优先；
- 后续可支持浅色主题；
- 状态徽章清晰；
- 卡片和表格紧凑；
- 命令可复制；
- 危险操作使用确认弹窗；
- 操作结果使用 Toast 或顶部提示；
- 空状态提供下一步操作入口。

### 17.1 标签体系

卡片和列表项应使用小标签标记 Profile 类型、状态、配置特征和风险。

标签分为以下几类：

#### 类型标签

| 标签 | 含义 |
| --- | --- |
| `Main` | Claude Code 默认配置 |
| `API` | Anthropic-compatible API Profile |
| `Login` | Claude 账号登录 Profile |
| `CCR` | Claude Code Router Profile |
| `Unknown` | 无法识别类型 |

#### 状态标签

| 标签 | 含义 |
| --- | --- |
| `Ready` | 配置完整，可用 |
| `Missing Settings` | 缺少 `settings.json` |
| `Invalid Settings` | `settings.json` 无法解析或结构异常 |
| `Missing Token` | API Profile 缺少 token |
| `Missing Base URL` | API Profile 缺少 Base URL |
| `CCR Offline` | CCR Profile 存在，但 CCR 服务未运行 |
| `Path Missing` | Profile 目录不存在 |
| `Unknown` | 无法判断 |

#### 配置标签

| 标签 | 适用对象 | 含义 |
| --- | --- | --- |
| `Default Model` | Main / Login / API | 未显式配置模型，使用 Claude Code 默认模型 |
| `Custom Model` | API | 显式配置了模型 |
| `Multi Model` | API | Opus / Sonnet / Haiku / Subagent 使用不同模型 |
| `Token Configured` | API | 已配置 token |
| `No Token` | API | 未配置 token |
| `Login State` | Login | 检测到 Claude 登录状态 |
| `No Login State` | Login | 未检测到登录状态 |
| `Preset Bound` | CCR | 已绑定 CCR preset / route |
| `Endpoint Bound` | CCR | 已绑定 CCR endpoint |

#### 风险和交互标签

| 标签 | 含义 |
| --- | --- |
| `Need Attention` | 有缺失、异常或不可用状态 |
| `Invalid` | 配置明显异常 |
| `Conflict` | 会话同步中发现冲突 |
| `Unsynced` | 有可同步会话 |
| `Sync Source` | 当前被选为同步来源 |
| `Sync Target` | 当前被选为同步目标 |
| `Recently Used` | 最近使用过，后续功能 |

标签视觉优先级：

```text
风险标签 > 状态标签 > 类型标签 > 配置标签
```

卡片视图建议最多展示 3 个标签：

1. 类型标签；
2. 主要状态标签；
3. 最重要的补充标签。

例如：

```text
[API] [Ready] [Custom Model]
[API] [Need Attention] [No Token]
[CCR] [CCR Offline] [Preset Bound]
```

列表视图可以展示 3-5 个标签；详情抽屉中可以展示全部相关标签。

### 17.2 Profile 卡片示例

Main Profile：

```text
┌────────────────────────────────────┐
│ main                               │
│ [Main] [Ready] [Main Config]       │
│                                    │
│ Claude Code default configuration  │
│ Path: ~/.claude                    │
│                                    │
│ [Details] [Sync From] [Sync To]    │
└────────────────────────────────────┘
```

API Profile：

```text
┌────────────────────────────────────┐
│ deepseek                           │
│ [API] [Ready] [Custom Model]       │
│                                    │
│ Model: deepseek-v4-pro             │
│ Base:  api.deepseek.com            │
│ Token: Configured                  │
│                                    │
│ [Edit] [Details] [Sync]        ⋯   │
└────────────────────────────────────┘
```

Login Profile：

```text
┌────────────────────────────────────┐
│ work                               │
│ [Login] [Ready] [Login State]      │
│                                    │
│ Claude account login profile       │
│ Path: ~/.claude-profiles/work      │
│                                    │
│ [Start Cmd] [Details] [Sync]   ⋯   │
└────────────────────────────────────┘
```

CCR Profile：

```text
┌────────────────────────────────────┐
│ gpt-route                          │
│ [CCR] [Ready] [Preset Bound]       │
│                                    │
│ Preset: gpt-route                  │
│ CCR:    Running                    │
│                                    │
│ [Edit Binding] [Open CCR UI] [Sync]│
└────────────────────────────────────┘
```

### 17.3 列表视图示例

列表视图按分组展示，并保留标签。

```text
API Profiles  4

Name        Tags                         Model              Base              Status        Actions
deepseek    [API] [Ready] [Custom]        deepseek-v4-pro    api.deepseek.com  Ready         Edit Details Sync
openrouter  [API] [No Token]              claude-sonnet      openrouter.ai     Attention     Fix Details Delete
moonshot    [API] [Multi Model]           moonshot-k2        api.moonshot.cn   Ready         Edit Details Sync
```

```text
CCR Profiles  2

Name        Tags                         Preset         CCR Status    Actions
gpt-route   [CCR] [Ready]                 gpt-route      Running       Open UI Edit Binding
gemini      [CCR] [CCR Offline]           gemini-route   Offline       Start CCR Details
```

可用组件：

- 状态徽章；
- Profile 卡片；
- Profile 表格；
- Modal；
- Confirm Dialog；
- Toast；
- Command Preview；
- Settings Form；
- Session Diff Table；
- Log View。

可用 `lucide` 图标：

- `User`：Login Profile；
- `Key`：API Profile；
- `Route`：CCR Profile；
- `Terminal`：启动命令；
- `Settings`：配置；
- `Trash2`：删除；
- `Copy`：复制；
- `FolderOpen`：路径；
- `RefreshCw`：刷新；
- `Shield`：安全提示；
- `Database` / `History`：会话同步。

## 18. MVP 范围

第一版应覆盖以下功能：

1. `ccp ui` 启动本地 Web UI；
2. Dashboard 展示简单统计信息；
3. Profiles 页面卡片 / 列表总览；
4. 快速创建 API Profile；
5. 快速创建 Login Profile；
6. 快速创建 CCR Profile；
7. 查看 Profile 状态；
8. 查看 Profile 详情；
9. 编辑 API Profile 配置；
10. 编辑 CCR Profile 绑定信息；
11. 删除 Profile，带输入名称确认；
12. 复制启动命令；
13. CCR 状态查看；
14. CCR start / restart；
15. 打开 CCR UI；
16. 会话同步可视化：
    - 选择 source / target；
    - 扫描；
    - 展示差异；
    - 选择同步；
    - 冲突确认；
    - 展示同步结果；
17. Activity / Logs 展示本次 Web 会话内的操作记录。

## 19. 暂缓功能

以下功能可以后续再做：

- 直接从 Web UI 打开交互式 Claude Code 终端；
- CCR 具体配置管理；
- Provider 模板库；
- Raw JSON 高级编辑器；
- 持久化操作日志；
- Token 有效性测试；
- Endpoint 可用性测试；
- 远程访问支持；
- 多用户认证；
- 完整主题系统。

## 20. 后续增强方向

- Profile 搜索和过滤；
- Profile 分组或收藏；
- 最近启动记录；
- 导入 / 导出 Profile；
- Provider 快速模板；
- 高级模型槽位编辑；
- Raw JSON 编辑器；
- 更详细的 session diff 信息；
- 会话同步历史记录；
- 浅色 / 暗色主题切换。

## 21. 实现原则

- Web UI 是 CLI 的可视化层，不是新的配置系统；
- 优先复用 `src/core` 中已有逻辑；
- 避免 CLI 和 Web 各自实现一套不同规则；
- Profile 管理是核心；
- 会话同步必须强调可视化和易操作；
- CCR 只做状态和服务控制，不接管配置；
- 所有敏感信息默认脱敏；
- 删除和覆盖类操作必须二次确认；
- 错误和失败必须真实展示。
