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

## 现在能做什么

| 模块 | 状态 | 说明 |
|---|---|---|
| 会话事件 | 可用 | append-only JSONL、投影、压缩锚点、自定义 session ID、生命周期 |
| 主循环 | 可用 | 多步工具调用、流式输出、审批、等待、超时、重试 |
| 上下文管线 | 可用 | stable / dynamic / ephemeral 分段；记忆推送段；预算裁切 |
| 模型 | 可用 | OpenAI Chat / Responses、Anthropic Messages、Google Generate Content；多 key、重试、并发闸门、按模型计价 |
| 工具 | 可用 | read / write / edit / bash / fetch / websearch / recall；结果 envelope、spill/offload、workspace lease、审批 |
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

### 2. 上下文管线

固定形状：

```text
sources → filter → budget → render
```

- stable / dynamic / ephemeral 分段，避免每轮重排稳定内容。
- 记忆推送是 dynamic section，由 `MemoryPushService` 选择后注入；它不是用户发言。
- 压缩后可以重新分析记忆推送；默认开启。
- dynamic 按优先级填，超预算就丢低优先级项；历史压缩由压缩器单独处理，不在管线里逐条裁旧消息。

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

边界：

- `log/` 只读，不改写；要修正就写新条目。
- `SOUL.md` / `USER.md` / `FACT.md` 是当前 agent 的独属文件，不进公用库。
- 一条记忆一件事；三档戳：`确信` / `可信` / `有疑`。
- 原话必须带 `log-addr`；找不到地址就不算原话。

### 5. 模型与余额

- 模型来源是配置，不是代码里的硬编码。
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
| 摘要单独生成、不退回抽取式 | 主 agent 模型按文件批量生成，无抽取式回退 | 质量取决于主模型；真实模型端到端测试还没做 |
| 本地 RAG 兜底 | FTS5 + 可选本地 embedding；未做系统评测 | 不是自主检索；召回质量没有基准 |
| 压缩能精确映射原文 | 压缩锚点、工具结果修剪、摘要保留；精确原文映射未做 | 旧内容只能按锚点/摘要取回，不能保证逐字还原 |
| DSH 互操作（插件桥 / ACP / SDK） | 未实现；DSH 只做参考 | 不绑 DSH 运行时，也不假装能直接装 DSH 插件 |
| 多窗口 UI、远程接入、computer-use、便携沙箱 | 只有默认 UI + Electron 壳 | 这些还在路线图，不在当前可用范围 |
| 多 agent 记忆隔离、旧记忆库导入 | 未实现；当前是共享库 + 私域标记 | 多 agent 共用一个库；旧库导入按你的要求先不做 |
| 余额覆盖所有内置厂商 | 只支持 DeepSeek / Moonshot / OpenRouter | OpenAI / Anthropic / Gemini 没有普通 key 余额接口；不抓控制台 |
| 插件面板多 slot / 右侧栏 | v0 只有设置页 slot | 先保证 sandbox 和契约；右侧栏等多窗口阶段再做 |

---

## 路线图

按优先级，不按愿望大小：

1. **扩展契约 v1**
   - 独立插件宿主（子进程/worker + 能力 RPC）
   - 第三方插件安装、签名、锁文件、卸载/更新
   - 模型 provider 插件、事件白名单、memory source
2. **Workspace / Project + 任务引擎**
   - 项目目录、任务状态、产物、回滚点
   - artifact store + 文档摄取 + RAG
3. **模型运行时**
   - 本地 Jev / embedding 一键部署
   - 真实模型下的摘要 / 选择 / 压缩评测集
4. **设备与桌面**
   - computer-use、设备调试桥、分 agent/工具沙箱
   - 多窗口、实时操作可视化、多文档编辑
5. **接入与协作**
   - 微信/远程通道、便携 agent 聊天客户端
   - DSH 互操作层（只做协议桥，不搬运行时）
6. **可观测与可靠性**
   - 评测、回放、备份、恢复、告警

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
