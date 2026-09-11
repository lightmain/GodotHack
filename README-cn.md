# BlissHack

[English](README.md) | [简体中文](README-cn.md)

> **上游与许可证声明**
>
> BlissHack 是基于 NetHack 5.0.0 的非官方修改版。NetHack 原始 README
> 已不作内容修改地保存在 [README-NetHack](README-NetHack)，原始许可证保存在
> [dat/license](dat/license)。BlissHack 并非 NetHack DevTeam 制作或支持；
> 浏览器前端特有的问题应反馈给本项目，而不是 NetHack 上游。

BlissHack 的目标是在现代浏览器中运行更加现代化版本的 NetHack。NetHack C
内核被编译为 WebAssembly，并通过上游 shim 窗口接口连接到 React/TypeScript
终端前端。
BlissHack 对 NetHack C 代码进行了少量有针对性的修改，主要用于修复浏览器
前端所需但 shim 接口尚未完整实现的行为。详情见
[当前项目对 shim 接口的修改](doc/BlissHack/shim-interface-reference.md#6-当前项目对-shim-接口的修改)。

## 项目状态

**prealpha-3 已完成，prealpha-4 正在开发。**

prealpha-4 是一个范围较小的纯代码重构版本，不增加玩家功能，主要拆分
前端大文件、明确模块职责，并降低后续开发和 Agent 修改所需的上下文。

当前里程碑已经实现：

- 可游玩的 80x21 字符地图，包括 NetHack 颜色、光标、宠物和背景 glyph。
- 消息历史、文本窗口、菜单、提示、扩展命令和位置输入。
- 先输入角色名字，再进入原版职业、种族、性别和阵营选择流程。
- 多行状态栏，以及位于角色名字和称号背景上的彩色生命值条。
- 准确的 ASCII、Ctrl、Alt/Meta、方向键和数字小键盘输入。
- 通过 Emscripten IDBFS 在浏览器本地保存和恢复游戏。
- 单元测试、WASM 集成测试和 Chromium 浏览器集成测试。
- GitHub Pages 自动部署。

这仍然是 pre-alpha 版本。在稳定版本之前，存档兼容性、界面细节和窗口端口覆盖
范围都可能发生变化。

## 在线游玩

<https://lightmain.github.io/BlissHack/>

存档保存在当前浏览器配置中，不会上传到服务器，也不会自动同步到其他浏览器或
设备。NetHack 写入的文件内容仍是原版二进制 save bytes；IDBFS 只负责把
Emscripten 虚拟文件及其文件系统元数据持久化到 IndexedDB。

主界面页脚和致命错误页可以导出本地诊断日志。诊断日志不会自动上传，也不记录
角色名、按键、游戏消息或存档内容。

## 操作方式

BlissHack 使用 NetHack 的标准键盘命令：

- 使用方向键或 `h`、`j`、`k`、`l` 移动角色。
- `Ctrl` 组合键编码为 ASCII 控制字符。
- `Alt` 组合键用于 NetHack Meta 命令。
- 操作系统的 `Command`/`Meta` 键保留给浏览器。
- 数字小键盘按照 NetHack 当前的 number-pad 模式工作。

完整数字对照及源码依据参见
[按键输入参考](doc/BlissHack/key-input-reference.md)。

## 本地开发

产品版本由根目录 `VERSION` 定义。前端开发和 CI 使用根目录 `.nvmrc` 指定的
Node.js 主版本。

仓库中的 `frontend/public/nethack.js`、`nethack.wasm` 和
`nethack-runtime.json` 是前端使用的 Emscripten 运行时三件套。

```sh
cd frontend
npm ci
npm run dev
```

生产构建：

```sh
cd frontend
npm run build
npm run preview
```

重新编译 WebAssembly 内核需要 Emscripten。请按照
[WASM 构建流程](doc/BlissHack/build-process.md)操作，并始终一起提交两个
运行时文件和校验记录。

## 测试

```sh
cd frontend
npm test
npm run lint
npm run test:integration
npm run test:integration:compat
npm run test:performance
npm run test:long
```

集成测试会运行真实 WASM 回调链和生产浏览器构建，覆盖启动、键盘输入、状态栏、
存档和恢复流程。跨浏览器基础组覆盖 Firefox 和 WebKit 的发布关键路径，性能
测试记录永久背包在不同条目数量下的更新和滚动表现。长流程测试用于发布前重复
验证游戏会话、继续保存和存档传输。

## 仓库文档

- [prealpha-1 计划](doc/BlissHack/plans/prealpha-1.md)
- [prealpha-2 计划](doc/BlissHack/plans/prealpha-2.md)
- [prealpha-3 计划](doc/BlissHack/plans/prealpha-3.md)
- [prealpha-4 代码重构计划](doc/BlissHack/plans/prealpha-4.md)
- [prealpha-3 发布验收](doc/BlissHack/plans/in-prealpha-3/release-acceptance.md)
- [上游修改清单](doc/BlissHack/upstream-modifications.md)
- [存档存储与读取方案评审](doc/BlissHack/plans/in-prealpha-2/save-format-review.md)
- [Game Module 生命周期](doc/BlissHack/plans/in-prealpha-2/module-lifecycle.md)
- [致命错误和诊断日志设计](doc/BlissHack/plans/in-prealpha-2/fatal-errors-and-diagnostics.md)
- [浏览器端到端测试设计](doc/BlissHack/plans/in-prealpha-2/browser-end-to-end-tests.md)
- [WASM 构建流程](doc/BlissHack/build-process.md)
- [Shim 接口参考](doc/BlissHack/shim-interface-reference.md)
- [按键输入参考](doc/BlissHack/key-input-reference.md)
- [Guidebook 中文索引](doc/BlissHack/guidebook-index-cn.md)
- [前端源码](frontend/src)

## 已知接口限制

当前上游 shim ABI 无法安全返回非空消息历史字符串，也没有暴露 `yn_number`。
BlissHack 会维持安全行为，而不会猜测未公开的内存或回调语义。详情记录在
[Shim 接口参考](doc/BlissHack/shim-interface-reference.md)中。

## 许可证

BlissHack 包含并派生自 NetHack，依照
[NetHack General Public License](dat/license)免费分发，并遵循其中的无担保
条款。构建浏览器可执行文件所需的完整对应源代码均在本仓库中提供。

NetHack 原始版权和许可证声明均予以保留。前端第三方依赖仍分别遵循各自的
许可证。

本仓库记录的 BlissHack 修改始于 2026 年。prealpha-1 增加了浏览器前端、
测试、文档和部署配置。项目对 NetHack C 代码的少量修改均在对应文件中标明，
并记录于
[Shim 接口参考的“当前项目对 shim 接口的修改”章节](doc/BlissHack/shim-interface-reference.md#6-当前项目对-shim-接口的修改)。
