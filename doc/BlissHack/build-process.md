# BlissHack WASM 构建流程

## 概述

本文档记录将 NetHack 5.0 编译为 WebAssembly 的完整流程，以及 WASM 产物如何与 React 前端集成。

## 前置依赖

- macOS 或 Linux
- 根目录 `.nvmrc` 指定的 Node.js 主版本
- 根目录 `.emscripten-version` 指定的 Emscripten SDK 完整版本
- GNU Make、宿主 C 编译器、POSIX shell、awk、sed、curl、tar、xz 和 Python 3

Node.js 和 Emscripten 的版本文件是权威来源。不得在文档或 CI 中改用
`lts/*` 或 `latest`。

### 安装 Node.js

使用支持 `.nvmrc` 的版本管理器，例如：

```bash
cd /path/to/BlissHack
nvm install
nvm use
node --version
```

### 安装 Emscripten

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
EMSCRIPTEN_VERSION="$(cat /path/to/BlissHack/.emscripten-version)"
./emsdk install "$EMSCRIPTEN_VERSION"
./emsdk activate "$EMSCRIPTEN_VERSION"
source ./emsdk_env.sh
```

验证安装：
```bash
emcc --version
# 必须与 .emscripten-version 完全一致
```

**注意：** 每次打开新终端都需要 `source emsdk_env.sh`，或者将其加入 shell profile。

## WASM 构建步骤

```bash
cd /path/to/BlissHack/frontend
npm ci
npm run build:wasm
```

该命令自动完成：

1. 在清理或编译前检查 Node.js、Emscripten 和其他构建工具。
   `emcc`、`emar` 和 `emranlib` 必须解析到同一个 emsdk 目录。
2. 执行 `make spotless`。
3. macOS 使用 `sys/unix/hints/macOS.500`，Linux 使用
   `sys/unix/hints/linux.500`。
4. 生成 Makefile，并在缺失时通过 `make fetch-Lua` 获取经过上游 checksum
   校验的 Lua 5.4.8。
5. 执行 `make CROSS_TO_WASM=1`。
6. 在 staging 目录生成并校验完整运行时三件套。
7. 以 `0644` 权限更新 `frontend/public` 并运行 WASM 集成测试；发布或测试
   失败时恢复更新前的完整三件套。

CI 或需要明确 hints 时使用：

```bash
cd frontend
npm run build:wasm -- --hints sys/unix/hints/linux.500
```

### 构建产物

构建完成后，产物位于项目根目录的 `targets/wasm/` 下：

```
targets/wasm/
  nethack.js      Emscripten 生成的 ES6 模块（胶水代码 + Asyncify 运行时）
  nethack.wasm    编译后的 WebAssembly 二进制（整个 NetHack C 核心 + Lua）
  wasm-data/      游戏数据文件，通过 --embed-file 打包进 .wasm 中
    nhdat         打包后的游戏数据（关卡、文本等）
    sysconf       系统配置
    perm          权限文件
    record        记录文件
    ...
```

统一构建命令随后更新：

```text
frontend/public/
  nethack.js
  nethack.wasm
  nethack-runtime.json
```

`nethack-runtime.json` 记录 Emscripten、Node.js、Lua、hints、宿主编译器、
Make，以及两个运行时文件的字节长度和 SHA-256。摘要只用于检查产物配对和
意外改写，不表示存档兼容性。

**关键理解：** `nethack.js` + `nethack.wasm` 是一体的。JS 文件是 WASM 的加载器和运行时，
不能分开使用。`wasm-data/` 中的文件在编译时被 `--embed-file` 嵌入到 .wasm 二进制中，
运行时通过 Emscripten 的虚拟文件系统 (FS) 访问，不需要单独部署。

### 编译标志说明

`make CROSS_TO_WASM=1` 触发的关键编译标志（定义在 `sys/unix/hints/include/cross-pre2.500`）：

| 标志 | 说明 |
|------|------|
| `-DSHIM_GRAPHICS` | 使用 shim 窗口接口 |
| `-DNOTTYGRAPHICS` | 不编译 TTY 接口 |
| `-DLIBNH` | 编译为库模式 |
| `-DCROSSCOMPILE -DCROSS_TO_WASM` | 交叉编译到 WASM |
| `-s ASYNCIFY` | 启用 Asyncify（允许 C 阻塞调用被 JS 异步化） |
| `-s MODULARIZE -s EXPORT_ES6=1` | 输出 ES6 模块格式 |
| `-s EXPORTED_FUNCTIONS` | 导出 `_main`, `_shim_graphics_set_callback` 等函数 |
| `-s EXPORTED_RUNTIME_METHODS` | 导出 `cwrap`, `ccall`, `FS`, `IDBFS` 等运行时方法 |
| `--embed-file wasm-data@/` | 将游戏数据嵌入 WASM 虚拟文件系统根目录 |

## WASM 产物不是"静态库"

传统的 C 静态库（`.a` 文件）是链接时使用的中间产物。WASM 的产物是**最终可执行模块**，
更接近于一个"可以被浏览器加载运行的程序"。

对比：

| | 静态库 (.a) | WASM 产物 (.js + .wasm) |
|--|------------|------------------------|
| 何时使用 | 编译时链接 | 运行时加载 |
| 包含什么 | 目标文件集合 | 完整的可执行程序 |
| 谁消费它 | 链接器 (ld) | 浏览器 / Node.js |
| 能否独立运行 | 不能 | 能（需要 JS 宿主环境） |

**注意：** 中间过程中确实会生成 `libnh.a`（NetHack 静态库），但 Emscripten 会将其与
Lua 库一起链接成最终的 `nethack.js` + `nethack.wasm`。我们只需要最终产物。

## 与 React 前端的集成方式

### React 应用的编译前状态（开发时）

```
frontend/
  public/
    nethack.js        ← 从 src/targets/ 复制过来的 Emscripten 产物
    nethack.wasm      ← 同上
  src/
    main.tsx              React 入口
    App.tsx               应用状态与页面组合
    nethack-bridge.ts     稳定 shim callback façade
    bridge/               module loader、WASM 解码、输入控制和存档校验
    session/              module/session 生命周期与 Home 数据操作
    screens/game/         游戏终端、状态栏、modal 和暂停组件
    screens/settings/     Settings 字段、数据操作和 modal 组件
    styles/               按页面职责拆分的全局样式
  index.html
  package.json
  vite.config.ts
  tsconfig.json
```

### React 应用的编译后状态（`npm run build`）

```
frontend/dist/
  index.html              入口 HTML
  assets/
    index-[hash].js       打包压缩后的 React 应用
    index-[hash].css      样式
  nethack.js              原样复制（不经过 Vite 打包）
  nethack.wasm            原样复制
```

**关键点：**
- `nethack.js` 和 `nethack.wasm` 放在 `public/` 目录中，Vite 会原样复制到 `dist/`，
  不对其进行打包、压缩或 tree-shaking
- `frontend/public/nethack.js`、`frontend/public/nethack.wasm` 和
  `frontend/public/nethack-runtime.json` 必须提交到仓库。GitHub Pages
  工作流不安装 Emscripten，而是先校验再发布这三个文件。重新编译 WASM 后，
  必须同时更新并提交完整三件套。
- React 代码在运行时通过 `import()` 动态加载 `nethack.js`，后者自动加载同目录下的 `nethack.wasm`
- 最终部署只需要把 `dist/` 目录整个放到任意静态文件服务器上

### 加载流程

```
浏览器加载 index.html
  → 加载 React 应用 (assets/index-[hash].js)
    → bridge/emscripten-module.ts 动态 import('nethack.js')
      → nethack.js 自动 fetch('nethack.wasm') 并实例化
        → WASM 模块初始化，挂载 globalThis.nethackGlobal
          → 我们的 JS 回调被注册到 shim
            → 调用 Module._main() 启动游戏
              → NetHack 游戏循环开始运行
```

## 切换构建模式的注意事项

在 WASM 构建和原生 TTY 构建之间切换时，必须先清理：

```bash
make spotless
cd sys/unix && sh setup.sh hints/macOS.500 && cd ../..
# 然后选择其中一种：
make                     # 原生 TTY
make CROSS_TO_WASM=1     # WASM
```

`make spotless` 会清理所有编译产物，确保干净的构建环境。

## 开发工作流（后续）

```
终端 1: 修改前端代码
  cd frontend && npm run dev    # Vite 开发服务器，HMR

终端 2: 如果修改了 C 代码（通常不需要）
  cd frontend
  npm run build:wasm            # 重建、复制、校验并运行 WASM 测试
```

正常开发中只改前端代码，WASM 模块编译一次后很少需要重新编译。

## 运行时校验

`npm run build` 会在 TypeScript 和 Vite 构建前运行
`frontend/scripts/verify-runtime-assets.mjs`。以下任一情况都会使生产构建
失败：

- manifest 或任一运行时文件缺失。
- `nethack.js` 不是 Emscripten ES module。
- `nethack.wasm` 没有合法的八字节 WASM 头。
- 文件长度或 SHA-256 与 manifest 不一致。
- manifest 的 Emscripten、Node.js 主版本或 Lua 版本与仓库固定值不一致。

## 手动 GitHub Actions

`.github/workflows/rebuild-wasm.yml` 使用固定的 `ubuntu-24.04`、Node.js 主版本
和 Emscripten 完整版本重建正式运行时。它执行单元测试、生产构建、WASM
集成测试和 Chromium 浏览器测试，并上传运行时三件套供审核。

该 workflow 不自动提交产物。下载产物后应检查三个文件的 diff，再按
`doc/BlissHack/upstream-modifications.md` 复核上游修改和测试。
