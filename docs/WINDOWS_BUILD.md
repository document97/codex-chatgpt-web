# Windows 安装包构建

本项目的 Windows 桌面端位于 `launcher/`，使用 Electron + electron-builder 打包，Windows 目标为 NSIS 安装程序。

## 环境要求

- Windows x64
- Bun 1.4.0
- Node.js 可在 `PATH` 中执行（`launcher/scripts/package.cjs` 会通过 `node` 启动 electron-builder）

先确认 Bun 版本：

```powershell
bun --version
```

预期输出：

```text
1.4.0
```

## 安装依赖

在仓库根目录安装根项目和 launcher 的锁定依赖：

```powershell
cd C:\Users\Glimmer\codex-chatgpt-web-repo
bun install --frozen-lockfile
cd launcher
bun install --frozen-lockfile
cd ..
```

这与仓库 CI / Release 工作流使用的依赖安装方式一致。

## 构建 Windows 安装包

在仓库根目录执行：

```powershell
bun run --cwd launcher package:win
```

`package:win` 会依次执行：

1. TypeScript typecheck
2. Vite renderer production build
3. 准备内置 runtime
4. electron-builder Windows 打包
5. NSIS 安装程序生成

Windows 打包必须在 Windows 上运行。`launcher/scripts/package.cjs` 会拒绝跨平台打包，因为应用会嵌入对应平台的 Bun runtime。

## 构建产物

最终可分发文件会复制到：

```text
launcher\artifacts\
```

安装程序命名格式来自 `launcher/package.json`：

```text
codex-web-gpt-<version>-win-x64.exe
```

例如当前版本 `5.0.8`：

```text
launcher\artifacts\codex-web-gpt-5.0.8-win-x64.exe
```

electron-builder 还可能生成同名 `.blockmap` 文件，普通手动下载安装主要使用 `.exe`。

当前 NSIS 配置为交互式、按用户安装：

```text
oneClick: false
perMachine: false
```

安装器允许用户选择安装目录，并创建桌面和开始菜单快捷方式。

## Smoke Test

安装包生成后执行：

```powershell
bun run --cwd launcher smoke:package
```

这会检查最终打包产物。

## 完整仓库验证

需要执行完整开发验证时运行：

```powershell
bun run verify
```

Release CI 的 Windows 流程还会在打包前准备 AVX2-independent Bun runtime，然后执行 `verify`、`app:package` 和 `app:smoke`。正式发布时应以 `.github/workflows/release.yml` 中的流程为准。

## 最简本地流程

```powershell
cd C:\Users\Glimmer\codex-chatgpt-web-repo
bun install --frozen-lockfile
cd launcher
bun install --frozen-lockfile
cd ..
bun run --cwd launcher package:win
bun run --cwd launcher smoke:package
```

发布前同时检查根目录 `package.json` 和 `launcher/package.json` 的版本号保持一致。
