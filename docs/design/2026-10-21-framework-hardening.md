# IF 框架加固设计

> 状态：P0 Phase 1–7 与 Batch D/E 已落代码；设计稿保留作回滚依据。
> 日期：2026-10-21（2026-10-23 更新）
> 范围：长会话成本、定量卸载、读时取出、UI 契约、P0 可靠性。
> 原则：能借的借形状，借不了的反复优化；先不变量，后功能；每阶段有回滚点。

---

## 0. 结论先行

这轮不直接做“大卸载 + 大 UI”。先补框架的三块地基：

1. **写入安全**：会话格式、可恢复尾行、单会话写者、路径与 ref 校验。
2. **投影成本**：投影从有效压缩链尾开始；token 账本与真实 usage 对齐。
3. **结果保留**：工具层限长 → 写时 spill → `recall(ref)` 取回；UI 与模型使用不同投影。

旧日志不靠“事后卸载”减字节。append-only 下旧行仍在；要减只能段归档或 fork。事后引用只用于投影和取回，不用于回收磁盘。

---

## 1. 问题与实测

### 1.1 已测到的成本

本机 Node 24，合成会话每轮 5 条事件（user / tool.call / tool.result / assistant / turn.completed）：

| 会话规模 | read | projection | render | heap |
|---|---:|---:|---:|---:|
| 5,000 事件 / 1KB 结果 | 18ms | 175ms | 18ms | 28MB |
| 20,000 事件 / 1KB | 64ms | 644ms | 67ms | 96MB |
| 50,000 事件 / 1KB | 163ms | 1,676ms | 196ms | 219MB |
| 20,000 事件 / 8KB | 259ms | 646ms | 456ms | 293MB |

结论：`store.read()` 全量重解析、`projectHistory()` 全量扫描；压缩只替换模型看到的区间，不降低事件条数，也不降低旧日志字节。

### 1.2 Cherry 的教训

- 长而快的流逐 chunk 深拷贝整条消息，渲染器内存二次方增长。
- 长 agent 轮次挤爆回放环，助手消息空白，待审批卡片跟着消失，会话死锁。
- 压缩预算按虚高的 `contextWindow` 算，触发太晚。

IF 的对应措施：不把完整历史塞进渲染器、不深拷贝、不做内存回放环、审批独立于消息渲染、压缩预算留安全系数。

---

## 2. 不变量

这些是后续所有实现的验收条件：

1. **事件日志只追加**。不修改、不删除、不重写已有事件行。
2. **投影是纯函数**。同一事件集 + 同一策略 → 同一输出；IO（取 blob）在投影之前完成。
3. **模型投影、UI 投影、归档检索是三份东西**。模型看预算内的内容；UI 看完整时间线（按需取全文）；归档看原始事件。
4. **模型投影确定性**。回填决策只由事件位置、大小、配置决定，不由运行时缓存命中率决定。
5. **事件与 blob 成对**。先写 blob，再追加事件；blob 缺失时降级为预览并报告，不让整轮崩溃。
6. **所有外部字符串先校验再拼路径**。`sessionId`、`logAddr`、`ref` 一律不信任。
7. **不做一次性大改**。每阶段有开关、基准、失败注入和回滚点。
8. **不绑 DSH 运行时**。只借契约、形状、交互；记忆、事件语义、投影、归档自研。

---

## 3. 借用地图

DSH 是 MIT。只借形状与契约，不 import 运行时。

| 层 | DSH 参考 | 借什么 | IF 适配 |
|---|---|---|---|
| 卸载存储 | `packages/spill/spill` | 单一 `saveText` 契约；不透明 locator + `bytes` + `retrievalHint`；所有权与来源分离；存储故障由调用方降级 | 换成 `ContentRef`；加 SHA-256、路径校验、session/agent 归属 |
| 卸载策略 | `packages/spill/spill-policy` | 按估算 token 预算保留首尾；提示中说明省略字节与取回方式；存储失败保留原内容；图片与文本共享预算 | 先文本，后结构化/二进制；预算按实际发送内容计算 |
| 压缩修剪 | `packages/compaction/compaction-tool-result-pruner` | 确定性单次收敛；按 Unicode 码点切片；头/标记/尾；shadow 事件引用原事件；原文留日志 | 接进现有 `compaction.pruned`；不另起事件体系 |
| 会话格式 | `packages/session/session-format` | header 版本；相邻迁移链；`recovery: 'recoverable'` 的可恢复后缀；编解码分派 | 首行 `session.created` 带 `formatVersion`；坏尾行只丢后缀，不丢整段 |
| JSON 存储 | `packages/storage/storage-json` | 临时文件 + fsync + 原子 rename；坏记录视为不存在；版本戳；安全 key 正则 | 用于 blob 写入与 sidecar；键名只接受安全字符 |
| 子 agent | `packages/subagent/subagent` | 请求即返回；完成通知；`maxDepth`；activation 容量；本地子级持久/冷恢复；取消与清理顺序 | 我们已有请求机制；补权限、预算、重启恢复、跨流取回 |
| UI 审批 | `packages/client/ui-approval` | 审批独立于消息；作用域交互；键盘/指针共用锁；临时决定与持久策略分离 | 审批收件箱独立于时间线；决定落事件，重启可恢复 |
| UI 对话 | `packages/client/ui-conversation` | `seq` 游标；增量组装；replace window；transient 事件与持久事件分开；按 Turn/Step 索引 | UI 时间线投影；分页；断线重连从事件日志游标恢复，不用回放环 |
| UI 工具卡 | `packages/client/ui-tool` | 按工具名注册视图；根/子调用树；折叠行；运行/完成/失败状态；文件大小与 diff 摘要；spill 输出展开 | 工具卡默认折叠；全文按 range 取；审批/工具卡解耦 |
| Token 计量 | `packages/llm/token-meter` | 回放式确定性估算；提供方 usage 锚点；`contextBreakdown`；CJK/JSON 低估警告 | 补 `TokenEstimator.observe`；按模型因子；留 0.9 安全系数 |
| 输出保留 | `packages/util/output-retention` | 头/尾字节窗口；不切断 UTF-8；代理项安全；统一省略提示 | `preview` 生成；不用 `slice` 随意切 |

### 3.1 自研部分

- 记忆系统：SOUL / USER / FACT / detail、原话地址、`log` 投影。
- IF 事件语义与流：`session:` / `task:` / `process:` / `agent:`。
- actor / principal / 名字解析。
- 归档器与记忆 log 投影。
- 卸载的路径/ref 安全边界、删除与保留策略。
- UI 的 token 占比、多模态聚合、vibecoding 实时进程流。
- fork / 分支 / 编辑重发语义。

自研部分统一走：不变量 → 小原型 → 失败注入 → 基准 → 集成。

---

## 4. 目标结构

```
事件日志（JSONL，只追加）
  ├─ Blob 库（内容寻址，文本/二进制）
  ├─ 模型投影（确定性、预算内、预览或全文）
  ├─ UI 时间线投影（游标分页、元数据 + 预览）
  └─ 归档/recall（显式读取原文）
```

### 4.1 数据形状

```ts
interface ContentRef {
  readonly ref: string          // blob:<sha256>
  readonly bytes: number
  readonly sha256: string
  readonly mime?: string
  readonly encoding?: string
  readonly preview: {
    readonly head: string
    readonly tail?: string
    readonly omittedBytes: number
  }
}
```

`tool.result` 事件：

```json
{
  "type": "tool.result",
  "payload": {
    "callId": "call-1",
    "text": "<head>…\n[offloaded 184320 bytes; ref blob:ab12…; use recall to read]",
    "isError": false,
    "bytes": 184320,
    "encoding": "utf-8",
    "contentRef": {
      "ref": "blob:ab12…",
      "bytes": 184320,
      "sha256": "ab12…",
      "mime": "text/plain",
      "encoding": "utf-8",
      "preview": { "head": "…", "tail": "…", "omittedBytes": 180000 }
    }
  }
}
```

当前代码在写 `tool.result` 时丢掉了 `ToolResult.ref / bytes / encoding`（`src/loop/run.ts`），先修这个，否则任何卸载都取不回。

### 4.2 会话格式

首行 `session.created` 作为 header，增加：

```json
{
  "type": "session.created",
  "seq": 0,
  "payload": {
    "formatVersion": 2,
    "sessionId": "session-...",
    "createdAt": "2026-10-21T...",
    "seqBase": 0
  }
}
```

- 新会话每条事件带单调 `seq`；旧会话没有 `seq`，读取时按文件顺序补虚拟序号。
- `formatVersion` 走相邻迁移链，不做静默重写。
- 最后一行不完整或非法：`recovery: 'recoverable'`，返回已接受前缀，并把坏后缀留在 `.corrupt.<ts>.txt`；若坏行之后还有合法事件，视为致命损坏。

### 4.3 单写者与锁

- 每会话一个 `SessionWriter`；同进程内所有追加（主循环、子 agent 回送、归档器）都走它。
- 跨进程写：默认拒绝；需要时用 `withFileLock` + 锁文件 `{pid, host, startedAt, heartbeat}`。
- 锁超时先检查 pid/host；同机进程不存在 → 清理；否则等待/报错，不静默删除活锁。
- 段轮转、压缩、归档在锁内做；普通追加在单写者内串行。
- blob 写入：临时文件 + fsync + rename；内容寻址，重复写入幂等。

### 4.4 卸载策略

三层量：

1. **单条阈值**：`maxInlineBytes` / `maxInlineTokens`。超过 → 写 blob，事件留预览 + ref。
2. **会话内联预算**：`sessionInlineBytes`。超过 → 只对模型投影做旧结果预览化；**不等于回收旧日志字节**。
3. **每步回填预算**：`hydrateItemBytes` / `hydrateStepBytes`。只回填当前 step 的结果，且按事件顺序取前 N 条直到预算；旧 step 一律预览 + ref。

v1 建议：

- 工具层先限长：`read` 加 `offset/limit`，`bash` / `fetch` 截断，`bash.structured` 不再复制 stdout/stderr。
- 仍超限的 `tool.result` 写时 spill。
- 模型投影：当前 step 内、单条不超回填上限的结果取回全文；其余预览 + ref。
- 模型需要更多 → `recall({ ref, offset, limit })`。
- 不做“按剩余预算、最近优先”的动态回填；不做旧事件批量 offload 当性能药。

失败行为：

- blob 写失败：保留内联；若超过硬上限，截断并写警告事件；工具调用仍算成功。
- blob 缺失/哈希不符：投影用预览 + `[blob missing]`；`recall` 明确报错；`doctor --deep` 报告。

### 4.5 模型投影

- `projectHistory` 从有效压缩链尾之后开始，先放摘要消息，再放尾部事件。
- 边界保护：若头部出现没有对应 `tool_use` 的 `tool_result`，向后移到下一个安全轮次起点；不把半对调用喂给模型。
- 回填在投影前完成，投影保持纯函数。
- `TokenEstimator` 每次模型调用后用真实 `usage.input` 校准；按模型记录因子。
- 压缩压力计算与实际发送内容同源；`contextWindow` 乘 0.9 安全系数。
- 子 agent 同样使用该投影；超过预算先压缩或硬停，不无限增长。

### 4.6 UI 契约

UI 不复用模型投影。列表接口只返回元数据和预览：

```ts
interface UiTimelineItem {
  id: string
  seq?: number
  type: string
  ts: string
  actor: string
  status?: 'running' | 'ok' | 'error' | 'cancelled'
  title: string
  summary?: string
  content?: {
    preview: string
    bytes: number
    mime?: string
    encoding?: string
    ref?: string
    truncated: boolean
  }
  tool?: { name: string; argsPreview?: string; resultPreview?: string; isError?: boolean; durationMs?: number }
  compaction?: { summary: unknown; anchor: unknown; tokensBefore: number; tokensAfter: number }
  agent?: { requestId: string; preset: string; status: string }
  usage?: { input: number; output: number; cacheRead: number }
}

interface PayloadSlice {
  data: string | Uint8Array
  offset: number
  bytes: number
  eof: boolean
}
```

接口：

- `getTimeline(sessionId, cursor, limit)`：按 `seq` 或事件 id 游标分页。
- `getPayload(ref, offset, limit)`：按 range 取全文；校验 ref 后读 blob。
- `getApprovals(sessionId)`：独立审批队列，不走消息列表。
- `getAgents()`：queued / running / terminal。
- `getSessionStats(sessionId)`：事件数、内联字节、blob 字节、压缩次数、token/费用。

UI 行为：

- 时间线虚拟滚动，只渲染视口。
- 工具卡默认折叠；展开全文是人的操作，**不改变模型上下文**。
- 审批收件箱常驻，不依赖某条消息是否展开。
- 压缩卡带 anchor 和“查看原文”，原文进归档视图。
- 子 agent 独立面板；父会话只放请求卡。
- 大文本卡内分页；复制/下载走 blob。
- 工具输出按不可信内容处理：HTML 不直接渲染，禁脚本/iframe，CSP 兜底。
- 流式更新节流、增量 append，不深拷贝整条消息。
- UI 技术栈后定；先做契约和 CLI `if show` 验证。

### 4.7 子 agent 加固

- 只读预设：硬过滤写工具（已做）。
- 非只读预设：危险工具默认要审批，不再在 guard 里直接 `allow`；按预设显式信任才可放行。
- 预算：每请求/每会话 token、费用、步数、时长上限；队列上限；并发上限。
- 队列恢复：启动读 `agent.requested`，找不到终态的运行中请求标 `interrupted`；可选重排。
- 子 agent 上下文：压缩或硬 token 上限；与主 agent 共用卸载策略。
- 跨流取回：`contentRef` 带 `sessionId`/`stream`；`recall` 显式允许跨流时校验归属。
- 结果：父会话只收摘要卡；完整 transcript 在 agent 视图，按需取。

### 4.8 路径与权限

- `sessionId`：`^[A-Za-z0-9._-]{1,128}$`；拼路径后 `resolve`，断言仍在 `sessions/` 下。
- `logAddr`：日期 `^\d{4}-\d{2}-\d{2}$`；session 段同上；`n` 正整数；拼路径后断言在 `log/` 下。
- `ref`：`^blob:[0-9a-f]{64}$`；拼路径后断言在 `blobs/` 下。
- 工具路径：默认限制在配置的 workspace roots；越界需审批。
- `fetch`：只允许 `http/https`；默认拒绝私网/链路本地/元数据地址；限制响应字节、重定向、超时；不带 `file://`。
- UI：本地 API 绑 `127.0.0.1` + token；CORS allowlist；HTML 消毒。
- 预览/日志脱敏：API key、token、密码字段打码。

---

## 5. 分阶段落地

每阶段都必须过：`tsc --noEmit`、对应 demo、失败注入、基准门槛。任一不过，停在本阶段。

### Phase 0：契约与测试骨架（本轮只做这个）

- 本文档。
- 测试目录骨架：`src/**/*.test.ts` 或 `tests/`。
- 失败注入工具：临时 dataRoot、假网关、断点 hook。
- 基准脚本：5k/20k/50k 事件；1KB/8KB/1MB 结果。

回滚：无代码改动。

### Phase 1：写入安全（P0）

- `session-format`：header、`formatVersion`、`seq`、可恢复后缀。
- `SessionWriter`：单会话串行；跨进程锁；stale lock 清理；段轮转锁内。
- 路径校验：`sessionId`、`logAddr`、`ref`。
- 修 `tool.result` 持久化：`ref / bytes / encoding / mime`。
- `bash.structured` 去重；`fetch` 响应字节上限。
- 子 agent 危险工具审批；预算字段。

回滚：`formatVersion: 1` 读旧格式；新写入可开关 `writer: legacy`。

### Phase 2：投影成本（P0）

- `projectHistory` 从压缩链尾开始；边界保护。
- `TokenEstimator.observe` 接入真实 usage；按模型因子；0.9 安全系数。
- 子 agent 压缩/硬 token 上限。
- 基准：50k 事件 projection 从 ~1.7s 降到与活跃尾部同量级。

回滚：`projectionCut: false`；`tokenCalibration: false`。

### Phase 3：卸载与取回

- `BlobStore`：SHA-256、分片目录、原子写、路径校验、range 读取。
- 写时 spill：`tool.result` 文本/结构化；预览生成。
- `recall(ref, offset, limit)`；跨流可选。
- 工具层限长：`read offset/limit`、`bash`/`fetch` 截断。
- 失败注入：blob 写失败、缺失、哈希不符、磁盘满。

回滚：`offload.enabled: false` → 全内联；已有 ref 仍可读。

### Phase 4：UI 契约与 CLI 验证

- `src/ui/timeline.ts`：UI 投影，纯函数。
- `src/app/ui-api.ts`：timeline 分页、payload range、approvals、agents、stats。
- CLI：`if show <session> [--full] [--ref]`、`if tail`、`if stats`。
- 不写正式 UI。
- 验收：10 万事件时间线分页不一次加载；展开 1MB 结果只取 range；审批队列独立。

回滚：API 纯增，不影响现有 CLI。

### Phase 5：段归档与 fork

- 归档 manifest：已压缩且无活跃引用的段标记 archived；`read()` 默认跳过，`readAll()`/recall 可读。
- fork：新会话 = 摘要 + 尾部事件 + blob 引用；旧会话只读留档。
- `if export`：事件 + blob + manifest 打包。
- 旧日志字节真正下降只在这里发生。

回滚：archive manifest 可删；原段不动。

### Phase 6：UI 实现（需单独定技术栈）

- 虚拟时间线、工具卡、审批收件箱、子 agent 面板、压缩卡、token/费用条。
- 安全：消毒、CSP、本地 API token。
- 性能门槛：10 万事件首屏 < 1s；流式更新不触发全列表重绘。

### Phase 7：观测与 CI

- 指标：每步 read/project/render、事件数、内联/blob 字节、回填命中、token/费用、队列深度。
- `doctor --deep`：blob 完整性、孤儿 agent、stale lock、磁盘、schema 版本。
- 基准回归门槛；失败注入纳入 CI。

已落（Batch E）：

- `Metrics`：`turn.*`、`model.attempts/retries/errors/duration`、`tool.calls/errors/duration`；`if metrics` 与 `GET /api/metrics` 可读。
- 模型重试：单次超时、指数退避 + 抖动、`Retry-After`、仅 5xx/429/网络错误重试；**已经吐过流的事件绝不重试**。
- 工具幂等：同一轮 `toolCallId` 已有 `tool.result` 就不再执行，重放不会二次产生副作用。
- bash 进程树：Windows `taskkill /T /F`，POSIX 独立进程组 `SIGTERM → SIGKILL`；中断、超时、输出超限共用。
- 策略层：`FsPolicy` 根目录 + realpath（防链接逃逸）；`NetworkPolicy` 私网/回环/链路本地/云元数据、DNS 逐地址、重定向逐跳复验；`patch.runtime` 可开关。

---

## 6. 待定决策

这些需要你拍板，我不替你定：

1. **UI 技术栈**：本地 Web（Vite + React/Svelte） / Tauri / Electron / 先 CLI。建议先契约 + CLI，栈后定。
2. **单用户单机？** 影响鉴权、多客户端、锁策略。
3. **卸载阈值**：单条字节/token、会话内联预算、每步回填预算。建议全部进配置。
4. **回填策略**：当前 step 全回填 / 只回填最新一条 / 纯显式 recall。建议当前 step + 单条上限。
5. **`structured` 处理**：小保留、大进 blob、还是完全不进事件。
6. **`seq` 方案**：写入 envelope（格式 v2）还是按文件顺序虚拟序号。建议写入。
7. **子 agent 危险工具**：一律审批 / 按预设信任 / 只读预设为主。建议默认审批。
8. **费用预算**：每轮/每会话上限；超限硬停还是只警告。
9. **保留与删除**：blob GC、会话删除、脱敏、导出；先不做自动删除。
10. **UI 范围**：只聊天时间线，还是含任务板、进程流、多模态。

---

## 7. 本轮明确不做

- 不写正式 UI。
- 不做任务驱动的持久队列（只留事件与接口）。
- 不做加密、压缩、多用户、远程访问。
- 不重写旧日志来“回收字节”；旧数据靠段归档/fork。
- 不引入 DSH 运行时依赖。
- 不自动删除 blob。
- 不在投影里做同步文件 IO。

---

## 8. 验收清单

### 8.1 失败注入

- [ ] blob 写完、事件未写 → 孤儿 blob，不产生悬空引用。
- [ ] 事件写完、blob 未落盘 → 读时降级预览 + 报告。
- [ ] JSONL 尾行半截 → 保留前缀，坏后缀单独存放。
- [ ] 两个进程同时 append → 单写者拒绝/锁等待，不交错。
- [ ] 崩溃留下 stale lock → 下次启动清理。
- [ ] blob 哈希不符/缺失 → `recall` 报错，投影不崩。
- [ ] `sessionId` / `logAddr` / `ref` 路径穿越 → 拒绝。
- [ ] 工具执行后结果写失败 → 不重复副作用；记录未完成。
- [ ] 子 agent 超时/中断/重启 → 终态正确，队列不丢。
- [ ] 审批中重启 → 恢复或明确取消。
- [ ] 10 万事件 + 1MB 结果 → 时间线分页、投影不 OOM。

### 8.2 基准门槛

- 50k 事件、1KB 结果：projection < 200ms（从链尾开始后）。
- 20k 事件、8KB 结果：heap < 150MB（卸载后）。
- 10 万事件：`if show` 首屏不加载全文，内存 < 200MB。
- UI 流式 1MB 文本：峰值内存 < 300MB，不冻结。

### 8.3 安全

- 路径穿越、SSRF、HTML 注入、ref 伪造、审批绕过各有测试。
- 工具输出不执行脚本。
- 本地 API 未带 token 拒绝。

---

## 9. 代码位置索引

| 主题 | 当前文件 |
|---|---|
| 事件存储 / 全量 read | `src/core/store.ts` |
| 文件锁 | `src/core/lock.ts` |
| 对话循环 / 每步投影 | `src/loop/run.ts` |
| 子 agent 执行 / guard | `src/agents/run.ts` |
| 子 agent 队列 | `src/agents/manager.ts` |
| 会话文件路径 | `src/app/session.ts` |
| 工具结果裁剪 | `src/compaction/prune.ts` |
| 历史投影 | `src/projections/history.ts` |
| token 估算 | `src/compaction/estimate.ts` |
| 模型重试/超时 | `src/model/retry.ts`、`src/model/openai.ts` |
| 文件沙箱 | `src/core/fs-policy.ts` |
| 网络策略 | `src/core/network-policy.ts` |
| 进程内指标 | `src/core/metrics.ts` |
| 工具结果幂等 | `src/tools/persist.ts` |
| spill | `src/tools/spill.ts` |
| recall | `src/tools/builtin/recall.ts` |
| 记忆地址解析 | `src/memory/quote.ts` |
| 配置 / 装配 | `src/app/config.ts`、`src/app/bundle.ts` |

---

## 10. 一句话

先把“不坏档、不越权、投影不扫全量”做稳，再谈卸载和 UI。卸载只对新数据减字节；旧数据靠段归档/fork。UI 和模型看两份投影，永远不要共用一份。

---

## 11. P0 续：host 锁与收件箱（2026-10-24）

这一轮先读了 DSH 与 Cherry 的实际运行时，再改方案。

### 11.1 DSH 的 session 写锁

`session-persistence-jsonl/src/lease.ts`：

- POSIX 用非阻塞 `flock(2)` 锁 `session.lock`；Windows 用按规范路径哈希命名的内核信号量，不用锁文件；
- 锁由内核持有，进程死掉（包括崩溃）自动释放；
- **故意不设 TTL**：活着的写者即使卡住也不能被抢锁，否则恢复写入会撕裂日志；
- POSIX 锁定后还要核对 inode 仍是锁路径上的文件，防止 unlink/重建竞争；
- 读句柄完全不碰锁；
- `session-checkpoint-policy` 在每次模型请求前、每次顶层工具执行前 `flush`，失败即拒绝下游。

### 11.2 Cherry 的 agent loop

打包的 `agent-loop.mjs` 里：

- 收件箱是持久化投影：`next-turn` / `next-step` 都是事件，不是进程内 Promise；
- 消息在 `pre-step` 才被 claim，进程重启后未 claim 的消息还在；
- 每个 agent 只有一个 `phase: idle | running | maintenance`，忙时只置 `wakeRequested`，不并行开轮；
- `followup` / `steer` / `inject` 分别对应下一轮、当前轮下一步、只注入不唤醒。

### 11.3 落到 IF 的改动

1. **`HostLease`**（`src/core/host-lease.ts`）：一个 dataRoot 同时只允许一个 host。用 Node 24 自带的 `node:sqlite`，在 `dataRoot/locks/host.db` 上持长期 `BEGIN IMMEDIATE`；第二个 host 得到 SQLITE_BUSY 就拒绝。进程崩溃时内核释放，不设 TTL。
2. **写者所有权校验**（`src/core/session-writer.ts`）：append/flush 前核对锁路径 inode 是否仍是自己 open 的那个；不是就 fail-closed。close 只删自己的锁，不误删新写者的锁。
3. **收件箱恢复**（`src/session/inbox.ts`）：未读边界是 `seq > max(所有完成轮的 lastSeenSeq)`，不是“最后一次 turn.completed 之后”。消息可能在一轮进行中、模型请求投影之后落盘，位置排在 turn.completed 前面却从未被看到。首次打开会话和 `if serve` 启动时补跑，`skipStartEvent`，消息本身已在事件流里。
4. **身份提议两阶段**（`src/memory/proposals.ts`）：先写 `applying` + 前后全文哈希，再改文件，最后写 `accepted`。崩溃后用 afterHash 认出已落盘，append 模式不重复追加；文件被外部改过则拒绝自动处理。
5. **跨进程 workspace 租约不进 P0**：HostLease 已经保证同一 dataRoot 只有一个 host；`dataRoot/workspaces/leases.db` 在单 host 下不提供额外互斥，反而多一个要维护的真相源。等真正支持“多 host 共享同一 workspace”时，锁库必须按 workspace 定位，而不是按 dataRoot。进程内 `WorkspaceLeaseManager` 的 TTL+续租保留，用于同 host 的路径/整仓公平调度。

### 11.4 验收

- 同 dataRoot 第二把 host 锁被拒绝；持有者进程被 SIGKILL 后锁可再获取。
- 锁文件被外部删掉后写者拒绝继续写，close 不误删新锁。
- 崩溃前未处理的 wake 消息在启动恢复时只补一轮；已读消息不重复。
- 消息落在 turn.completed 之前但晚于 lastSeenSeq 时仍会被恢复。
- 身份提议 apply 成功但状态没落盘，重试不重复追加；applying 期间目标被外部改过则报错。

| 主题 | 文件 |
|---|---|
| host 锁 | `src/core/host-lease.ts` |
| 写者所有权 | `src/core/session-writer.ts` |
| 收件箱边界 | `src/session/inbox.ts` |
| 启动恢复 | `src/app/bundle.ts`、`src/app/cli.ts` |
| 身份提议幂等 | `src/memory/proposals.ts`、`src/memory/identity.ts` |

---

## 12. 会话生命周期（2026-10-24）

### 12.1 状态

- `active`：默认；可运行、可收消息、出现在列表里。
- `archived`：从默认列表隐藏；不能唤醒/收消息；历史仍可读。可 `unarchive` 回到 active。
- `deleted`：软删除终态；隐藏、不可再运行/收消息；历史文件保留，UI/审计仍可按 id 查看。不可 unarchive。

事件是 `session.lifecycle`，写在 `workspace:default` 流，和 `session.link` 共用同一个真相源；不修改会话自己的 append-only 日志。没有 lifecycle 事件的会话默认 active。

### 12.2 行为

- `listSessions` / `agentRuns` 默认只列 active；`includeArchived` / `includeDeleted` 显式打开。
- `sendMessage` 的 from/to 都必须是 active；`spawnSession` 的 creator 必须是 active。
- `runSessionTurn`、`queueInboxWake`、join 的 `wake` 都先检查 `canRun`。
- 归档/删除正在跑的会话默认拒绝；`force` 只挡后续唤醒，不中止当前轮。当前轮可以收尾，但不能再创建/派发新工作。
- 删除时先落 `deleted` 终态，再关闭涉及它的 active link，并取消所有涉及它的 pending join。顺序保证后续清理失败也不会让会话重新可写。
- 如果被删/归档的会话是 join 的目标，等待方会收到一条 `[join] 等待已取消：...` 系统注入并被唤醒；如果它就是等待方，静默取消，不唤醒一个已经不能跑的会话。
- 子 agent 的终态回送先查来源会话是否还能收消息；归档/删除后结果只留在 agent 流里。
- `delete` 是软删除，不删盘。硬删除/purge 需要单独的显式命令，等 UI 和审计需求明确后再做。

### 12.3 接口

- App：`sessionState`、`archiveSession`、`unarchiveSession`、`deleteSession`、`sessions({includeArchived,includeDeleted})`、`agentRuns({...})`。
- CLI：`archive` / `unarchive` / `delete`（`--reason`、`--force`）；`sessions --all`、`agents --all`。
- HTTP：`POST /api/sessions/:id/archive|unarchive|delete`；`GET /api/sessions?includeArchived=1&includeDeleted=1`；`GET /api/agents?includeArchived=1&includeDeleted=1`。

### 12.4 验收

- 归档后默认列表隐藏、恢复后重新出现。
- 删除后默认列表隐藏，link 关闭，等待被取消；直接 chat 被拒绝。
- 正在跑时归档/删除默认报错；`force` 下当前轮能收尾，之后不再唤醒。
- 旧 agent 流的终态列表也认生命周期。
