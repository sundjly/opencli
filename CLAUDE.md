# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is OpenCLI

OpenCLI 将任意网站或 Electron 桌面应用转为 CLI 命令。通过 Browser Bridge Chrome 扩展复用用户已登录的 Chrome 会话，支持 YAML 声明式管道和 TypeScript 浏览器注入两种适配器模式。

## Commands

```bash
# 开发运行
npm run dev                              # tsx src/main.ts
npm run build                            # tsc + clean-yaml + copy-yaml + build-manifest

# 类型检查
npx tsc --noEmit

# 测试（vitest 配置了 3 个 project: unit, adapter, e2e）
npm test                                 # 仅核心单元测试（排除 adapter）
npm run test:adapter                     # 仅 adapter 测试（zhihu/twitter/reddit/bilibili/linkedin/grok）
npm run test:e2e                         # E2E 测试（需先 build）
npm run test:all                         # 全部测试
npx vitest run src/registry.test.ts      # 单个文件
npx vitest src/                          # watch 模式

# E2E 测试需要先 build（依赖 dist/main.js）
npm run build && npm run test:e2e

# 验证适配器
opencli validate                         # 检查所有 YAML 定义
opencli validate <site>                  # 检查特定站点
```

## Architecture

### 双引擎架构

1. **YAML Pipeline Engine** — 声明式数据管道，适合 API 抓取类命令
   - 管道步骤: `fetch`, `evaluate`, `navigate`, `select`, `map`, `filter`, `sort`, `limit`, `intercept`, `tap`, `snapshot`, `click`, `type`, `wait`, `press`, `download`
   - 模板语法: `${{ args.limit }}`, `${{ item.title }}`, `${{ index + 1 }}`

2. **TypeScript Adapter** — 编程式浏览器交互，适合复杂场景（XHR 拦截、无限滚动、Cookie 提取）

### 核心模块

| 模块 | 路径 | 职责 |
|------|------|------|
| **入口** | `src/main.ts` | 启动发现、补全快速路径、触发 onStartup hook |
| **CLI 路由** | `src/cli.ts` | Commander 命令注册与路由 |
| **注册表** | `src/registry.ts` | `cli()` / `registerCommand()`，Strategy 枚举，CliCommand 接口 |
| **发现** | `src/discovery.ts` | 命令发现（manifest 快速路径 / 文件系统扫描），YAML/TS 自动加载 |
| **执行** | `src/execution.ts` | 命令执行，浏览器会话管理，hook 触发 |
| **管道** | `src/pipeline/` | YAML 管道执行器，步骤处理器在 `pipeline/steps/` |
| **浏览器** | `src/browser/` | Browser Bridge 通信，IPage 抽象，CDP 连接，tab 管理，daemon 客户端 |
| **输出** | `src/output.ts` | table/json/yaml/md/csv 多格式渲染 |
| **Hook** | `src/hooks.ts` | 插件生命周期钩子（onStartup, onBeforeExecute, onAfterExecute） |
| **插件** | `src/plugin.ts` | 插件安装/卸载/更新，`~/.opencli/plugins/` 管理 |
| **外部CLI** | `src/external.ts` | 外部 CLI hub（gh, docker 等），自动安装与透传 |
| **类型** | `src/types.ts` | `IPage` 接口定义 |

### 适配器加载流程

1. `main.ts` 调用 `discoverClis()` + `discoverPlugins()`
2. **生产快速路径**: 读取 `cli-manifest.json`（build 时由 `build-manifest.ts` 生成），YAML 管道内联零解析，TS 模块懒加载
3. **开发回退路径**: 运行时扫描 `src/clis/` 目录，解析 YAML + 动态 import TS
4. 适配器放在 `src/clis/<site>/<command>.yaml` 或 `.ts`，自动注册，**不需要手动 import**

### 5 级认证策略

| 级别 | Strategy | 说明 |
|------|----------|------|
| 1 | `public` | 无需认证，Node.js fetch |
| 2 | `cookie` | 浏览器 fetch + credentials: include |
| 3 | `header` | 自定义请求头（ct0, Bearer） |
| 4 | `intercept` | XHR 拦截 + store mutation |
| 5 | `ui` | 完整 UI 自动化（click/type/scroll） |

### Browser Bridge

CLI 通过 `extension/` 下的 Chrome 扩展 + 本地 daemon（端口 19825）与浏览器通信。扩展用 Vite 构建，源码在 `extension/src/`。

### Electron 桌面应用适配

通过 CDP（Chrome DevTools Protocol）连接 Electron 应用。启动时加 `--remote-debugging-port=9222`。每个 Electron 适配器遵循 5-command 模式: `status`, `send`, `read`, `new`, `dump`。详见 `CLI-ELECTRON.md`。

### 测试架构

Vitest 配置了 3 个 project（`vitest.config.ts`）：

| Project | 范围 | 说明 |
|---------|------|------|
| `unit` | `src/**/*.test.ts`（排除 `src/clis/**`） | 核心模块单元测试 |
| `adapter` | `src/clis/{zhihu,twitter,reddit,bilibili,linkedin,grok}/**/*.test.ts` | 指定站点 adapter 测试 |
| `e2e` | `tests/**/*.test.ts` | E2E 集成测试（子进程运行 dist/main.js） |

单元测试与被测模块同目录放置（`foo.ts` 旁放 `foo.test.ts`）。

## Code Style

- TypeScript strict mode，ES Modules（import 用 `.js` 扩展名）
- 文件名 `kebab-case`，变量 `camelCase`，类型 `PascalCase`
- Named exports only，不用 default export
- Conventional Commits: `feat(twitter): ...`, `fix(browser): ...`，scope 用站点名或模块名

## Key Docs

- `CLI-EXPLORER.md` — 适配器探索式开发完全指南（AI Agent 必读）
- `CLI-ONESHOT.md` — 单点快速 CLI 生成（4 步）
- `CLI-ELECTRON.md` — Electron 应用 CDP 适配指南
- `SKILL.md` — 命令参考和适配器模板
- `TESTING.md` — 测试架构、覆盖范围、CI 流水线
- `CONTRIBUTING.md` — 贡献指南
