# 发布与独立环境测试

## 版本

版本号唯一来源是仓库根目录的 `VERSION` 文件。当前：

```text
V0.0.1.3
```

改版本时只改 `VERSION`，发布脚本、CLI `--version`、`/api/version` 都读它。`package.json` 的 `version` 保持同步即可。版本号支持 `x.y.z` 和 `x.y.z.w`；第四段是补丁修订号。

> V0.0.1 内置的更新器只认三段版本号，读到 `0.0.1.1` 会报 `update_version`。从 V0.0.1 升到 V0.0.1.1 要用新包的 `install.cmd` 覆盖安装，或便携包替换 `In_Fate/`；V0.0.1.1 → V0.0.1.2、V0.0.1.2 → V0.0.1.3 可直接走内置更新；从 V0.0.1.1 起后续四段版本都可正常走内置更新。

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
release/In_First/                        独立目录
release/In_First-v0.0.1.3-win32-x64.zip   Windows 当前平台压缩包
```

如果只想出后端 + UI 的便携包，不带 Electron：

```bash
npm run release:portable
```

### 单文件安装器 exe

发布 zip 生成后，可以再包一个单文件 Windows 安装器：

```bash
npm run installer
# 或一次完成：npm run release:setup
```

产物：

```text
release/In_Fate-Setup-v0.0.1.3-win32-x64.exe
release/In_Fate-Setup-v0.0.1.3-win32-x64.exe.sha256
```

`tools/installer-bootstrapper.cs` 用系统自带的 .NET Framework `csc` 编译，不依赖 NSIS / Inno Setup / 7-Zip。exe 尾部依次是发布 zip、16 字节 magic 和 8 字节 payload 长度；运行时把自己解到 `%TEMP%\In_Fate-Setup-<guid>`，再调用包内 `install.cmd`。它会把用户参数原样转交给安装器，并在前面补 `--launch`；测试时可以传 `--no-launch --no-shortcuts --no-registry --dir <临时目录>`，不会碰真实安装。安装结束后清理临时目录。

单文件 exe 依赖系统自带的 .NET Framework 4.5+（Windows 10/11 自带），没有代码签名，Windows SmartScreen 可能提示未知发布者；正式分发前应签名。

## 包内结构

```text
In_First/
  In_Fate/          程序：bin/src/ui/dist/desktop/package（整体可替换）
  data/             数据根：会话、记忆、插件数据（更新时不动）
  previous/         上一版本（更新后可回滚；运行时生成）
  .updates/         更新暂存与 pending（运行时生成）
  runtime/          当前平台 Node（拷贝失败则回退系统 node）
  config/           可变配置
  logs/             运行日志
  backups/          完整数据备份（预留）
  tools/            安装器、Windows 快捷方式/卸载登记集成、启动前更新切换
  install.cmd/.sh   安装到本机（Windows 双击）
  repair.cmd        安装后生成：重建启动脚本/快捷方式/卸载登记
  uninstall.cmd     安装后生成：卸载，默认保留 data
  smoke.mjs         独立冒烟测试
  start-if.cmd/.sh  浏览器/CLI 启动
  start-desktop     桌面启动（包含 desktop 时）
  VERSION
  release.json      构建清单（含 zip 的 sha256/size）
```

`In_Fate/` 是程序层，`data/` 是数据层。升级时整体替换 `In_Fate/`；`data/` 不动。

## 安装到本机

Windows 双击 `install.cmd`，Linux/macOS 运行 `./install.sh`。

默认位置（Windows；Linux/macOS 对应 `~/In_First`）：

```text
%USERPROFILE%\In_First\In_Fate    程序
%USERPROFILE%\In_First\data       数据
```

都是用户目录下的可见文件夹，不写 AppData，也不请求管理员权限。`--dir` 和 `--data-dir` 可以改成任意位置。

安装器分两步：Node 负责程序层与数据布局，`tools/windows-install.ps1` 负责 Windows 原生的快捷方式和卸载登记。

1. 先检查发布包、目标路径和数据目录，并做 Windows 集成预检：在桌面/开始菜单各建一个临时 `.lnk`，在卸载登记父键下建一个临时值，确认能写后立即删除。
2. 把程序复制到 `.install-staging-*`，再整体切换到 `In_Fate`；旧程序层移到 `previous/`。复制失败会回滚。
3. 写启动、卸载、修复脚本和 `if-home.txt`。
4. 创建正式快捷方式：先写临时 `.lnk`，回读校验 `TargetPath` 与参数，再替换正式文件。快捷方式显式指向 `wscript.exe`，不依赖 `.vbs` 文件关联。
5. 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\In_Fate`，包括 `DisplayName`、`DisplayVersion`、`Publisher`、`InstallLocation`、`DisplayIcon`、`UninstallString`、`QuietUninstallString`、`ModifyPath`、`InstallDate`、`EstimatedSize` 和 `NoRepair`；每个值写完后回读校验。
6. 以上都通过后才写 `install.json`、打印「完成」并启动。

任何一步失败都不会打印完成：首次安装失败会清掉本次登记并回滚程序层；升级失败会把 `previous/` 换回来并恢复旧版本的快捷方式和卸载登记。全过程写入 `logs/install.log`。

双击 `install.cmd` 安装完成后会直接启动 In_Fate；以后从桌面/开始菜单的「In_Fate」快捷方式打开，或运行安装根下的 `start-desktop.cmd`。`--no-launch` 可关闭自动启动。`--no-shortcuts`、`--no-registry`、`--portable`、`--data-dir`、`--uninstall`、`--purge`、`--force`、`--repair`、`--dry-run` 可用。`--portable` 表示就地注册当前发布包，不复制到默认安装根；目标目录非空且不像 In_First 安装根时安装器会拒绝，`--force` 可跳过。升级安装保留数据与配置，旧程序层留在 `previous/`。

安装根会生成 `repair.cmd`：快捷方式、卸载登记或启动脚本丢失时，双击它即可重建，不复制程序、不动数据。`uninstall.cmd` 默认保留 `data/`；`uninstall.cmd --purge` 才连数据一起删。卸载登记里的 `UninstallString` 带 `--from-registry`，从「设置 → 应用」卸载时不会停在 `pause`。

## 内置更新

设置 → 关于与更新。

- 更新源是 `latest.json`；支持 `http(s)`、`file:` 或本地路径。发布时它和 zip 一起放在 `release/` 根（同一目录）。
- 清单格式：

```json
{
  "version": "0.0.2",
  "url": "if-v0.0.2-win32-x64.zip",
  "sha256": "64 位十六进制",
  "size": 123456,
  "notes": "可选",
  "publishedAt": "可选"
}
```

- `url` 可以是相对路径，按清单地址解析。
- 下载后校验 size 与 sha256；解压前检查 zip 条目（拒绝绝对路径和 `..`），解压后校验 `VERSION` 和 `bin/if.ts`，并限制解压总字节（2GB）与文件数（20 万），拒绝符号链接。
- 更新包暂存在 `.updates/<version>`；点「应用更新」只写 `pending.json`。下次用 `start-if` / `start-desktop` 启动时，`tools/apply-pending.mjs` 把旧 `In_Fate` 移到 `previous`，再把暂存程序切到 `In_Fate`。运行中的进程不替换自己的文件。
- 设置里可以回滚到 `previous`。
- 没有更新源时，可以直接选择本地发布包 zip，走同一套校验/暂存/pending；低于当前版本的包会被拒绝，同版本允许用于重装。
- 允许跨版本更新：程序层是完整包，不依赖中间补丁；数据层由 `DATA_MIGRATIONS` 链决定，跨过多个 schema 版本时必须在链里补齐对应迁移，否则启动拒绝。回滚只保留 `previous` 一代。
- 开发环境（直接从仓库根运行）不支持应用更新；请用发布包测试。
- 清单签名还没做；目前依赖 HTTPS 与 sha256。`npm run release` 会把 zip 的 sha256 和 size 写进 `latest.json` 与 `release.json`。

## 独立环境测试

安装版测试：运行 `install.cmd` 装到默认目录后，从桌面快捷方式启动；程序在 `%USERPROFILE%\In_First\In_Fate`，数据应出现在 `%USERPROFILE%\In_First\data`。

免安装版：

```text
start-desktop.cmd      桌面版
start-if.cmd           浏览器/CLI 版
```

两者都使用包内 `runtime/` 和 `In_Fate/desktop/node_modules/electron/dist`，不要求系统另装 Node 或 Electron。启动脚本默认设置：

```text
IF_HOME=包根目录/data
IF_PORTABLE=1
```

`IF_HOME` 就是数据根本身，数据直接写在 `data/` 里，不会碰开发目录。安装版把 `IF_HOME` 指到 `%USERPROFILE%\In_First\data`，程序目录（`In_Fate/`）仍可单独替换。

## 首次配置

发布包默认没有模型服务商：

1. 打开设置 → 模型服务，添加 provider 与 key。
2. 打开右侧状态 → 当前模型，给 `main` agent 选模型并保存。
3. 新建会话即可开始。

配置写回 `config/if.release.json`；数据根由 `IF_HOME` 决定。

## 数据版本与升级

- 程序版本在 `VERSION`；数据 schema 版本在 `data/.state/data-schema.json`。
- 第一次启动写入当前 schema；同版本升级只更新 `appVersion`。
- 旧 schema 需要迁移时，会先把 schema 状态备份到 `data/.state/backups/`，再按 `DATA_MIGRATIONS` 顺序执行。
- 没有注册迁移时拒绝打开旧数据，不静默改库。
- 数据 schema 比程序新时拒绝降级打开。
- 程序更新与数据迁移分开：先切换程序层，启动时再按新程序的迁移链处理数据；迁移失败不会自动降级程序。
- 当前迁移链为空；这是骨架，后续每个数据变更都要加迁移函数和升级测试。

## 冒烟测试

```bash
./runtime/node smoke.mjs
# 或
node smoke.mjs
```

它会启动后端、等 `/api/health`、校验 `/api/version` 和 UI `index.html`，然后退出。默认使用包内 `data/`；设置 `IF_SMOKE_HOME=<临时目录>` 可以把冒烟数据放到别处，避免污染最终发布包。

## 可选依赖

后端核心不依赖 `node_modules`。本地 embedding 需要：

```bash
npm install --omit=dev
```

不装时，FTS 检索和普通对话仍可用；语义索引会不可用。发布包默认不带 `node_modules`，避免把开发依赖和平台无关文件一起塞进去。

## 已知限制

- 发布包按当前平台/架构生成；Windows 包不能直接拿到 Linux/macOS 跑。
- 拷贝的是当前 Node 二进制；如果目标机器缺少系统运行库，可能无法启动，此时改用系统 Node 24 并确保 `runtime/` 为空或改名。
- Electron 桌面版仍使用当前 `desktop` 壳；多窗口还没做。
- 更新清单没有签名校验；只适合自己的更新源，正式分发前应加 Ed25519 签名。
- 更新包是整个发布 zip（约 185M），下载/解压会占用磁盘；暂无增量更新。
- 安装器主体是 Node 脚本 + `cmd`/`sh` 启动器 + `tools/windows-install.ps1`；单文件 exe 是自解压 bootstrapper，不是 NSIS/Inno Setup 向导式安装器，且未签名。Windows 快捷方式、HKCU 卸载登记、修复和卸载验证已做。
- 发布包不含测试和 `DSH源码/`。
