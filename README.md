# In_Fate（IF）

> 本地优先、事件溯源的 agent 框架与桌面工作台。
>
> 当前快照：**2026-11-18**。这份 README 是活的：实现变了就改，不把“设计过”写成“已经做完”。

---

## 这是什么

IF 是一套自己维护的 agent 系统，不是 DSH 的二次封装。

- **DSH 只做参考实现和原语来源**，不引入 Cordis、不绑定 DSH 运行时。
- 行为层自己维护：会话事件、上下文管线、工具契约、记忆入口、插件契约、UI。
- 机制层能借就借：进程、锁、流式、token 估算、存储原语；借不到就自己写，但先写不变量和失败模式。
- 目标不是“复刻谁”，是把你自己的使用习惯、记忆和多种模型/工具收进一个本地工作台。

默认形态：

```text
CLI / 本地 HTTP API / React UI / Electron 壳
        ↓
会话事件流（append-only JSONL）
        ↓
上下文管线（sources → filter → budget → render）
        ↓
模型适配器 + 工具注册表 + 记忆系统 + 插件注册表
```

---

## 设计管线（按讨论顺序）

这不是功能清单，是已经定过的形状。README 只摘结论，专项细节在 `docs/` 和记忆库里。

1. **2026-10-18：五条线**
   上下文（记忆/工作流、每轮推送、外接数据、RAG、翻译/PDF/解析）、事件与展示（对话、token 占比、多模态、实时进程推送）、驱动（任务驱动与对话驱动兼容）、执行（高自由度工具、终端绕开 GBK）、模型与协同（多 agent、内置本地 LLM、ComfyUI）。
2. **2026-10-18：三样地基**
   事件模型（追加、带类型、可投影）、上下文管线形状（`sources → filter → budget → render`）、工具结果 envelope（`bytes` / `encoding` / `mime` / `structured`）。这三样先定，内容后定。
3. **2026-10-21：借用边界**
   DSH 只借装配/生命周期、loop 调度骨架、进程/存储原语、接入协议、服务 seam；工具管线、事件语义、压缩、沙箱、模型适配、驱动、记忆入口、UI 全部自定。`AGENTS.md` / `CLAUDE.md` 不是可蹭协议。
4. **2026-10-21：UI 卸载 ≠ 模型上下文**
   会话窗把历史从 UI 卸下、滚动/跳转再取回，和模型上下文压缩/工具结果外置是两条线，必须分开命名、分开阈值。UI 叫“会话窗历史卸载/分页驻留”，模型叫“上下文压缩/结果外置”，存储叫“段归档/fork”。
5. **2026-10-24：会话图 v3**
   所有会话归用户；`createdBy` / `createdFrom` 只做溯源，不产生父子/权限层级。连接走独立 `workspace.jsonl`，`peer | handoff | reference`；消息只进目标收件箱，不合并历史。`SessionHost` 保证同一会话单 active turn、不同会话并行；`join` 登记 all/any + timeout，等待不占模型；写隔离用 `WorkspaceLeaseManager`；模型准入用 `ModelGate`；记忆权限按 `MemoryGrant` 能力位，不按主/子。
6. **2026-11-01：模型归属与计量**
   模型目录/单价是全局配置；agent 的主模型、子 agent 模型、预设、工具白名单/审批放 `<dataRoot>/agents/<agentId>/settings.json`，不进记忆库 git，也不写进身份槽位。没有全局默认模型；没有 `models.main` 的 agent 直接阻止运行。`turn.completed` 记录 usage/model/耗时/成本；缓存命中是输入子集；峰谷价按模型自定义时段，历史成本不因改价重算。
7. **2026-11-06：记忆架构**
   记忆根默认 `<dataRoot>/memory`，布局 `detail + log + proposals + summaries + agents + indexlist`；不依赖外部 hook/Python。两档记忆：`rag-tool` 与 `jev-push`，另有 `off`。Jev 只做选择，不做推理、不做摘要、不写库；触发 `off | once | always`，`once` 是每段上下文第一次 + 压缩后，`always` 是常驻而不是每轮重推。选择范围默认不是全库，可选 session/agent/domain/target/all。摘要单独生成，存 `summaries/`，不塞进 detail 正文。本地 Jev 由 IF 管运行时；API 模式必须显式确认并提示记忆外发。
8. **2026-11-13：产品方向**
   IF 是多样化聚合平台，默认 UI 只是起点：UI 拓展、多窗口互连/传输/动效；内置 ComfyUI；内置 RAG、翻译、格式转换；微信与远程接入；computer-use 与设备调试；两层便携沙箱（agent 自身沙箱 + 给 agent 用的沙箱）；可选角色稳定插件（可自定义，不是绕过安全）；便携 agent 聊天接口；多文档编辑；实时操作可视化与 VS Code 内嵌。
9. **2026-11-14：插件 v0**
   不引 Cordis；`PluginManifest / PluginContext / PluginRegistry` 三件套；只做 tool + ui-panel，builtin/dev 进程内；第三方安装、沙箱宿主、provider、事件总线、市场留 v1。详见 `docs/plugins.md`。

**当前优先级**（2026-11-14 定）：扩展契约/插件 SDK → Workspace + 任务引擎 → 产物仓库 + 统一摄入/RAG。理由：不先做这三样，ComfyUI、翻译、格式转换、多窗口、远程接入会各自长成孤岛。

---

## 现在能做什么

| 模块 | 状态 | 说明 |
|---|---|---|
| 会话事件 | 可用 | append-only JSONL、投影、压缩锚点、自定义 session ID、生命周期 |
| 主循环 | 可用 | 多步工具调用、流式输出、审批、等待、超时、重试 |
| 上下文管线 | 可用 | stable / dynamic / ephemeral 分段；记忆推送段；dynamic 按优先级预算丢弃 |
| 模型 | 可用 | OpenAI Chat / Responses、Anthropic Messages、Google Generate Content；多 key、重试、并发闸门、按模型计价；无全局默认模型 |
| 工具 | 可用 | read / write / edit / bash / fetch / websearch / recall；结果 envelope、spill/offload、writeScope lease、审批 |
| 会话协作 | 可用 | 子 agent、session link、send/wake、join、归档/软删除 |
| 记忆 | 可用 / 部分 | 内置记忆库、detail/summaries/proposals/agents、FTS5 检索、可选语义索引、Jev 启发式选择、摘要后台队列 |
| 记忆编辑器 | 可用 | 结构树、文件编辑、移动/重命名、回收站、策略、摘要重建、提交 |
| 插件 | v0 | tool / ui-panel；builtin 与显式 dev 插件；沙箱 iframe 面板；无第三方安装 |
| 模型余额 | v0 | DeepSeek / Moonshot / OpenRouter 按 key 查询；其余厂商显示不支持 |
| UI | 可用 | 会话列表、时间线、审批、agent、状态、设置、模型、记忆、插件 |
| 桌面壳 | 可用 / 开发 | Electron 拉起 `if serve`，随机端口 + token；无安装包/自动更新 |
| 评测与备份 | 未完成 | 只有 metrics / doctor 和单元测试，没有系统级评测、回放集和备份策略 |

---

## 快速开始

要求：**Node.js >= 24**。

```bash
npm install

# 1. 准备本机配置
cp config/if.example.json config/if.local.json
# 编辑 config/if.local.json：dataRoot、provider、model、key

# 2. 自检
npm run check
npm test

# 3. 构建 UI
cd ui
npm run build
cd ..

# 4. 起本地服务
node bin/if.ts serve -c config/if.local.json --port 8787 --token dev
```

打开：

```text
http://127.0.0.1:8787/?token=dev
```

CLI：

```bash
node bin/if.ts chat -c config/if.local.json
node bin/if.ts run "帮我看一下这个目录" -c config/if.local.json
node bin/if.ts tools -c config/if.local.json
node bin/if.ts doctor -c config/if.local.json
```

桌面包：

```bash
npm run desktop
# 或
cd desktop && npm install && npm start
```

桌面壳的细节在 [`desktop/README.md`](desktop/README.md)，UI 细节在 [`ui/README.md`](ui/README.md)。

---

## 设计骨架

### 1. 事件与会话

- 会话是追加式事件流，不是可变聊天记录。
- 事件带类型、actor、seq、时间；投影负责把它变成历史消息和 UI 时间线。
- 压缩用锚点引用旧事件；归档/软删除只改生命周期，不直接删盘。
- 会话 ID 只允许安全段；`agent-` 前缀保留给子 agent。
- 所有会话归用户；`createdBy` / `createdFrom` 只做溯源，不产生父子、权限或调度层级。
- 连接是独立 `workspace.jsonl` 里的 `peer | handoff | reference` 边；消息只进目标收件箱，不把两个会话历史合并。
- 同一会话同一时刻只有一个 active turn，不同会话可以并行；等待用 `join` 登记，当前 turn 结束后进入 `waiting`，不占模型。
- 写隔离按 `WorkspaceLeaseManager`：`write` / `edit` 取 path 锁，`bash` 取 workspace 锁；审批后再取，finally 释放。
- 记忆权限按 `MemoryGrant` 能力位，不按主/子 agent；默认用户会话 steward、agent 会话 worker。

### 2. 上下文管线

固定形状：

```text
sources → filter → budget → render
```

- stable / dynamic / ephemeral 分段，避免每轮重排稳定内容。
- 记忆推送是 dynamic section，由 `MemoryPushService` 选择后注入；它不是用户发言。
- 压缩后可以重新分析记忆推送；默认开启。
- dynamic 按优先级填，超预算就丢低优先级项；历史压缩由压缩器单独处理，不在管线里逐条裁旧消息。
- **UI 卸载和模型上下文是两条线**：会话窗的虚拟列表/分页驻留只管 DOM 和消息取回；模型侧的压缩、工具结果外置、token 水位单独计算。现在 UI 有虚拟列表和时间线分页，但还没有按页释放/驻留策略；模型侧有压缩和 offload，但 55% / 78% / 92% 三段水位还没有完整接成一条可配置管线。

### 3. 工具契约

工具结果永远是 envelope，不是裸 string：

```ts
{
  text?, structured?, bytes?, encoding?, requestedEncoding?,
  mime?, ref?, contentRef?, structuredRef?, isError?,
  waiting?, presentation?
}
```

- 模型只看到 `name` / `description` / `inputSchema`；输出 schema、审批、展示投影留在宿主。
- 声明 `meta.writeScope` 的工具执行前会取 workspace 写租约；大输出走 spill / offload。
- 插件工具同样是这个契约，不能另造一套。

### 4. 记忆

公开记忆库默认在 `dataRoot/memory`：

```text
detail/       一条一事的事实条目
summaries/    生成式摘要（由主 agent 模型生成）
proposals/    agent 提议，等待用户接受
agents/       主 agent manifest
log/          IF 内部 MemoryLogService 从事件流生成 hook 兼容行，只读，不进 git
policy.json   记忆策略
```

用法：

- 三种模式：`rag-tool`（模型自己调检索）、`jev-push`（框架选择后推送）、`off`。
- Jev 只做选择，不做推理、不做摘要、不写库。触发 `off | once | always`；`once` 是每段上下文第一次 + 压缩后，`always` 的设计语义是常驻、不是每轮重推（当前实现见偏差表）。
- Jev 选择范围默认不是全库，可选 session / agent / domain / target / all；私域不进入选择包。
- 摘要单独生成，存 `summaries/`，不塞进 detail 正文；设计上摘要项要能带 `sourceEventIds` / `log-addr`，压缩后优先在压缩区间内选并推定点原文。
- 本地 Jev 由 IF 自己的模型运行时管理，不绕 Ollama；API 模式必须显式确认，并提示记忆外发风险。

边界：

- `log/` 只读，不改写；要修正就写新条目。
- 主 agent 的身份文件是 `memory/agents/<id>/agent.json` 和 `identity/principle.md` / `preference.md` / `prompt.md`。这是设计上的入口；旧 `SOUL.md` / `USER.md` / `memory/FACT.md` 只是迁移来源，不是运行时约定。当前代码还保留“无 manifest 时读旧文件”的 legacy 兼容分支，迁移完成后应删除。
- 一条记忆一件事；三档戳：`确信` / `可信` / `有疑`。
- 原话必须带 `log-addr`；找不到地址就不算原话。

### 5. 模型与余额

- 模型来源是配置，不是代码里的硬编码。
- 模型目录和单价是全局配置；agent 的主模型、子 agent 模型、预设、工具白名单/审批在 `<dataRoot>/agents/<agentId>/settings.json`，不进记忆库 git，也不写进身份槽位。
- 没有全局默认模型；没有 `models.main` 的 agent 直接阻止运行。旧 `defaultModel` 只保留兼容解析，不参与运行。
- `turn.completed` 记录 usage / model / 耗时 / 成本；缓存命中是输入子集；峰谷价按模型自定义时段，历史成本不因改价重算。
- 一个 provider 可以有多个端点格式、多把 key；key 只在宿主侧使用。
- 余额查询按 key 走 provider adapter；当前只支持 DeepSeek、Moonshot/Kimi、OpenRouter。
- 余额结果缓存 60 秒，5 秒超时；不支持就不发请求。详见 [`docs/model-balance.md`](docs/model-balance.md)。

### 6. 插件 v0

三件套：

```text
PluginManifest  →  PluginContext  →  PluginRegistry
```

- `plugin.json` 声明 `id` / `version` / `apiVersion` / `entry` / `provides` / `capabilities`。
- v0 只支持 `tool` 与 `ui-panel`；只允许 builtin 和显式开启的 dev 插件。
- 插件工具命名空间为 `<plugin>__<tool>`，默认停用、审批 required；agent 必须显式 allow。
- 面板只走 `iframe sandbox="allow-scripts"` + `srcDoc` + CSP，只能 postMessage。
- 插件存储是 5MB 的私有 KV，原子落盘。
- 这是 v0 阶段子集，不是完整插件平台；provider / 事件 / memory source / channel / job / 市场都没有。
- 详见 [`docs/plugins.md`](docs/plugins.md)。

---

## 目录地图

```text
src/
  app/          启动、装配、CLI、HTTP、会话列表
  core/         事件存储、锁、blob、spill、指标、workspace lease
  session/      生命周期、连接、send/wake、join
  agents/       子 agent、预设、设置、恢复
  loop/         主循环
  context/      上下文分段与管线
  model/        模型适配器、注册表、重试、闸门、余额
  tools/        工具契约、注册表、执行器、内置工具
  memory/       记忆库、摘要、提议、策略、检索、推送
  plugins/      插件契约、清单、注册表、存储、SDK
  projections/  事件投影
  ui/           UI 时间线与 payload 切片
ui/             React 工作台
desktop/        Electron 壳
docs/           设计与专项文档
tests/          node:test 测试
```

---

## 进度

当前验证基线：

- `npm test`：**228** 个测试全过
- `npm run check`：`tsc --noEmit` 通过
- `cd ui && npm run build`：通过

重点已完成：

- 事件溯源会话 + 自定义 session ID
- 子 agent、会话连接、join/wake、生命周期
- 多模型格式适配、多 key、重试、并发闸门、计价
- 工具审批、workspace lease、spill/offload、结果 envelope
- 内置记忆库、结构编辑、策略、摘要 worker、FTS/语义索引、Jev 启发式推送
- 插件 v0：内置示例、dev 插件、工具/面板、sandbox iframe、私有 KV
- 模型余额 v0：DeepSeek / Moonshot / OpenRouter，按 key 查询

---

## 与之前设计的偏差 / 未覆盖范围

这部分是给你“看偏没偏”的，不藏。

| 之前的设计 / 预期 | 当前实现 | 影响 |
|---|---|---|
| 完整插件平台、第三方安装、插件市场 | v0 只允许 builtin / dev；进程内；无第三方安装 | 先验证契约，第三方要等沙箱宿主；现在的 `capabilities` 不是安全隔离 |
| 插件可注册模型 provider、事件、memory source、channel、job | v0 只有 tool / ui-panel | provider 插件会看到全部 prompt，风险高；先不做 |
| 通用插件事件总线 | v0 没有；只有面板 postMessage | 避免插件监听全部会话、伪造核心事件 |
| 真正的 Jev 4B / Jev API 选择 | 本地启发式选择；API 后端未接 | 现在能按正文/摘要打分，但不是 Jev 模型；语义能力有限 |
| Jev `always` 只表示常驻，不每轮重推 | `MemoryPushService` 目前 `always` 每轮重新选择 | 语义偏差；需要改成常驻缓存 + 事件触发重选，或明确改成每轮 |
| 压缩后只在压缩区间内选，摘要带 `sourceEventIds` / `log-addr` | 选择器仍按全量历史/记忆打分；摘要只有 `entryId` / title / summary / keywords | 压缩定点原文推送未实现，摘要不能精确定位来源事件 |
| 摘要单独生成、不退回抽取式 | 主 agent 模型按文件批量生成，无抽取式回退 | 质量取决于主模型；真实模型端到端测试还没做 |
| 本地 RAG 兜底 | FTS5 + 可选本地 embedding；未做系统评测 | 不是自主检索；召回质量没有基准 |
| 压缩能精确映射原文 | 压缩锚点、工具结果修剪、摘要保留；精确原文映射未做 | 旧内容只能按锚点/摘要取回，不能保证逐字还原 |
| 模型上下文按 55% / 78% / 92% 三档水位分层 | 有压缩和 offload，但没有完整可配置的三段管线 | 触发仍是单一压缩配置，卸载/压缩/硬停没有按水位分开 |
| UI 会话窗历史卸载 / 分页驻留 | 有虚拟列表和时间线分页；没有按页释放/驻留策略 | 大历史会话的 DOM/内存控制还不完整 |
| 写隔离跨进程 | `WorkspaceLeaseManager` 目前是进程内协调 | 同一 workspace 多进程/多 host 同时写没有磁盘锁 |
| 记忆库除 log 外都能编辑 | `proposals` / `agent.json` / `meta.json` 仍只读；已有会话不能改 ID | 结构编辑覆盖不完整 |
| 旧 hook log 迁移/去重 | 新内部 log 从事件流生成；旧 log 的重复/回填未处理 | 旧流水不能直接当新库历史用 |
| 本地 embedding 语义检索 | 代码和单测有；真实权重下载/推理未实测 | 召回质量、预处理、`node-llama-cpp` 原生运行时未验证 |
| DSH 互操作（插件桥 / ACP / SDK） | 未实现；DSH 只做参考 | 不绑 DSH 运行时，也不假装能直接装 DSH 插件 |
| 多窗口 UI、远程接入、computer-use、便携沙箱 | 只有默认 UI + Electron 壳 | 这些还在路线图，不在当前可用范围 |
| 多 agent 记忆隔离、旧记忆库导入 | 未实现；当前是共享库 + 私域标记 | 多 agent 共用一个库；旧库导入按你的要求先不做 |
| 身份只认 manifest + identity 槽位 | 代码仍保留无 manifest 时读取旧 SOUL/USER/FACT 的兼容分支 | 迁移期兼容，不是设计；迁移完成后应删除，否则身份入口有两套 |
| 余额覆盖所有内置厂商 | 只支持 DeepSeek / Moonshot / OpenRouter | OpenAI / Anthropic / Gemini 没有普通 key 余额接口；不抓控制台 |
| 插件面板多 slot / 右侧栏 | v0 只有设置页 slot | 先保证 sandbox 和契约；右侧栏等多窗口阶段再做 |

---

## 已确认、还没施工（功能规划 18 项 + 设计管线未覆盖项）

这张表对应 2026-11-14 的规划，以及前面设计管线里已经明确、但还没落地的能力。状态只写实际程度，不把“方向定了”写成“做完了”。

| 项目 | 状态 | 说明 |
|---|---|---|
| 扩展契约 / 插件 SDK | 部分 | v0 只有 tool / ui-panel；命令、设置页、后台任务、事件订阅、权限、配置 schema、热插拔、审计都没有 |
| Workspace / Project 层 | 未 | 会话、文件、记忆域、agent、产物、权限还没有项目级组织 |
| 任务 / 作业引擎 | 未 | 定时、长任务、队列、进度、取消、恢复、任务看板都没有 |
| 统一收件箱 | 未 | 审批、agent 完成、定时结果、远程消息、设备告警仍分散 |
| 对话展示的 token 占比 / 多模态聚合 | 部分 | 轮次 usage/cost 有数据；没有完整 token 占比视图和多模态消息聚合 |
| 产物仓库 | 未 | 图片、文档、代码、音频、ComfyUI 输出没有统一来源/版本/引用 |
| 连接器 | 未 | 文件系统、浏览器、Git、邮箱、日历、数据库、IM、远程设备都没有统一连接器层 |
| 统一摄入管线 | 部分 | 记忆有 FTS/可选 embedding；普通文档的解析、OCR、切分、翻译、格式转换、RAG 没串起来 |
| 模型运行时管理器 | 部分 | 本地 embedding 有一键安装/激活；LLM、Jev、reranker、vision、translation、ComfyUI 的统一运行时没有 |
| Computer-use / 设备桥 | 未 | 桌面、浏览器、串口、USB、ADB、网络设备都没有统一可审计通道 |
| 两层便携沙箱 | 未 | agent 自身沙箱 + 给 agent 用的沙箱；目前只有路径/网络/workspace lease 级控制 |
| 角色稳定插件 / 自定义角色层 | 未 | 设计为可选、可自定义、不绕过安全；插件 v0 没有身份注入、沙箱隔离和一致性评测 |
| agent 操作实时可视化 / VS Code 内嵌 | 未 | 只有事后时间线/事件流；没有 started/progress/completed 推送、实时画布、VS Code 事件桥 |
| 多文档编辑 | 未 | Office/PDF/Markdown 展示、选区操作、版本、批注、diff 都没有 |
| MCP / ACP / 外部 SDK 接入 | 未 | 当前只有本地 HTTP API；MCP 服务器、ACP、SDK 协议都未接 |
| 权限与密钥中心 | 部分 | 有 key 配置、工具审批、workspace lease；没有按 agent/插件统一授权与审计的中心 |
| 可观测与回放 | 部分 | 有 metrics、事件流、timeline；没有“模型实际看到什么 / Jev 推了哪包 / 压缩前后差异”的回放 |
| 评测与回归 | 未 | 角色一致性、记忆召回、Jev 选择、翻译、格式转换、工具调用都没有基准集 |
| 备份 / 迁移 / 便携配置 | 未 | profile、agent、记忆、插件配置还不能整体导出/导入/加密 |
| 多窗口 / UI 拓展 / 动效 | 未 | 默认 UI 是唯一形态；没有窗口互连、视图注册、动效层 |
| 手机 / 远程瘦客户端 | 未 | 认证、会话附着、断线重连、审批转发、消息队列都没有 |
| 全局搜索 / 命令面板 / 上下文检查器 | 部分 | 有命令面板；跨会话/文档/记忆/产物搜索和“模型实际上下文检查器”没有 |
| 通知 / 任务 / 产物中心 | 未 | 三类平台级视图都没有 |
| 优先顺序 | 已定 | 扩展契约/插件 SDK → Workspace + 任务引擎 → 产物仓库 + 统一摄入/RAG |

---

## 路线图

按 2026-11-14 定的优先级，不按愿望大小：

1. **扩展契约 / 插件 SDK v1**
   - 独立插件宿主（子进程/worker + 能力 RPC）
   - 第三方插件安装、签名、锁文件、卸载/更新
   - 命令、设置页、后台任务、事件订阅、权限声明、配置 schema、热插拔、审计
   - 模型 provider 插件、事件白名单、memory source
2. **Workspace / Project + 任务引擎**
   - 项目目录、任务状态、依赖、进度、取消、重试、恢复、回滚点
   - 会话、文件、记忆域、agent、权限的项目级隔离
3. **产物仓库 + 统一摄入 / RAG**
   - 图片、文档、代码、音频、ComfyUI 输出：来源、版本、预览、引用、归档
   - 拖入文件后的解析 → OCR → 切分 → 索引 → 翻译/格式转换 → RAG
4. **模型运行时**
   - LLM、Jev、embedding、reranker、vision、translation、ComfyUI 统一下载/激活/资源/健康检查/回退
   - 真实模型下的摘要 / 选择 / 压缩评测集
5. **设备与桌面**
   - computer-use、设备调试桥、两层便携沙箱
   - 多窗口、实时操作可视化、多文档编辑
6. **接入与协作**
   - 微信/远程通道、便携 agent 聊天客户端
   - DSH 互操作层（只做协议桥，不搬运行时）
7. **可观测与可靠性**
   - 模型实际上下文 / Jev packet / 压缩差异回放
   - 评测、备份、恢复、告警、统一收件箱

---

## 维护约定

这份 README 随代码更新，规则只有三条：

1. **状态只写实际能跑的**。设计过但没实现的，放“偏差”或“路线图”。
2. **每次改动更新顶部日期**，并同步“进度 / 偏差 / 验证基线”。
3. **文档和代码一起提交**。专项细节放 `docs/`，README 只留总览和索引。

验证命令：

```bash
npm run check
npm test
cd ui && npm run build
```

---

## License

MPL-2.0，见 [`LICENSE`](LICENSE)。
