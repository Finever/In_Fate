# 发布与独立环境测试

## 版本

版本号唯一来源是仓库根目录的 `VERSION` 文件。当前：

```text
V0.0.1
```

改版本时只改 `VERSION`，发布脚本、CLI `--version`、`/api/version` 都读它。`package.json` 的 `version` 保持同步即可。

## 构建

```bash
npm run release
```

这会依次执行：

1. `npm run check`
2. `npm test`
3. `npm run build:ui`
4. `node scripts/release.mjs`

产物：

```text
release/if-v0.0.1/                    独立目录
release/if-v0.0.1-win32-x64.zip       Windows 当前平台压缩包
```

如果只想出后端 + UI 的便携包，不带 Electron：

```bash
npm run release:portable
```

## 包内结构

```text
if-v0.0.1/
  app/current/      程序：bin/src/ui/dist/desktop/package
  runtime/          当前平台 Node（拷贝失败则回退系统 node）
  config/           可变配置
  data/             可变数据：会话、记忆、插件数据
  logs/             运行日志（预留）
  backups/          完整数据备份（预留）
  smoke.mjs         独立冒烟测试
  start-if.cmd/.sh  浏览器/CLI 启动
  start-desktop     桌面启动（包含 desktop 时）
  VERSION
  release.json      构建清单
```

`app/current` 是程序层，`data/` 是数据层。升级时只替换程序层；数据层不动。

## 独立环境测试

桌面版：

```text
start-desktop.cmd
```

浏览器版：

```text
start-if.cmd
```

两者都使用包内 `runtime/` 和 `app/current/desktop/node_modules/electron/dist`，不要求系统另装 Node 或 Electron。启动脚本默认设置：

```text
IF_HOME=包根目录
IF_PORTABLE=1
```

数据写在 `IF_HOME/data`，不会碰开发目录。安装版以后可以把 `IF_HOME` 指到 `%LOCALAPPDATA%\In_Fate`，程序目录仍可单独替换。

## 首次配置

发布包默认没有模型服务商：

1. 打开设置 → 模型服务，添加 provider 与 key。
2. 打开右侧状态 → 当前模型，给 `main` agent 选模型并保存。
3. 新建会话即可开始。

配置写回 `config/if.release.json`；数据根由 `IF_HOME/data` 决定。

## 数据版本与升级

- 程序版本在 `VERSION`；数据 schema 版本在 `data/.state/data-schema.json`。
- 第一次启动写入当前 schema；同版本升级只更新 `appVersion`。
- 旧 schema 需要迁移时，会先把 schema 状态备份到 `data/.state/backups/`，再按 `DATA_MIGRATIONS` 顺序执行。
- 没有注册迁移时拒绝打开旧数据，不静默改库。
- 数据 schema 比程序新时拒绝降级打开。
- 当前迁移链为空；这是骨架，后续每个数据变更都要加迁移函数和升级测试。

## 冒烟测试

```bash
./runtime/node smoke.mjs
# 或
node smoke.mjs
```

它会启动后端、等 `/api/health`、校验 `/api/version` 和 UI `index.html`，然后退出。

## 可选依赖

后端核心不依赖 `node_modules`。本地 embedding 需要：

```bash
npm install --omit=dev
```

不装时，FTS 检索和普通对话仍可用；语义索引会不可用。发布包默认不带 `node_modules`，避免把开发依赖和平台无关文件一起塞进去。

## 已知限制

- 发布包按当前平台/架构生成；Windows 包不能直接拿到 Linux/macOS 跑。
- 拷贝的是当前 Node 二进制；如果目标机器缺少系统运行库，可能无法启动，此时改用系统 Node 24 并确保 `runtime/` 为空或改名。
- Electron 桌面版仍使用当前 `desktop` 壳；多窗口、自动更新、安装包还没做。
- 发布包不含测试和 `DSH源码/`。
