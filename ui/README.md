# IF UI（前端原型）

当前是本地 Web 前端，接 `if serve` 的本地 API：

```bash
# 终端 1：后端
node bin/if.ts serve -c config/if.local.json --port 8787 --token devtoken

# 终端 2：前端
cd ui
npm install
npm run dev
```

打开 `http://127.0.0.1:5173/?token=devtoken`。

- 会话窗按轮虚拟化；只保留视口附近的轮，远处整轮从 `TurnCache` 释放。
- 工具结果默认折叠；点“展开全文”才按 ref/事件 id 调 `/payload` 取切片。
- 审批在左侧独立收件箱，不依赖消息卡是否展开。
- 数据全本地，仅 `127.0.0.1`；token 在 `localStorage` 里。

Tauri 桌面壳暂未接：本机没有 Rust 工具链。接壳时只需把同一套前端放进 Tauri，Node 核心作为 sidecar 启动。
