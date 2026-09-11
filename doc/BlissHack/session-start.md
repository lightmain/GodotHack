# BlissHack Agent Session 启动清单

本文是每个新 Agent session 的最小启动入口。目标是先建立可靠的当前上下文，
再按任务加载资料，避免凭上一 session 的记忆工作或一次性读取大型文档。

## 1. 每次必读

开始分析或修改前，按顺序完成：

1. 完整阅读仓库根目录的 `AGENTS.md` 和 `AGENTS-cn.md`。
2. 阅读 `README-cn.md`，确认当前产品定位、运行方式、测试入口和许可证说明。
3. 当前版本为 prealpha-4。阅读
   `doc/BlissHack/plans/prealpha-4.md` 的版本目标、范围边界、当前任务所属阶段、
   阶段验收标准和阶段交付规则。prealpha-4 只做行为保持的前端代码重构；
   涉及现有功能契约时再读取对应的 prealpha-2 或 prealpha-3 设计文档，不需要
   无目的地加载全文。
4. 检查仓库现场：

   ```bash
   git status --short
   git log -5 --oneline --decorate
   git remote -v
   ```

5. 打开当前任务直接涉及的实现文件及其测试。不得只根据计划或旧文档推断现状。

如果工作树中已有改动，应先判断其归属，不得覆盖或回退用户及其他 Agent 的
修改。按照 `AGENTS-cn.md` 的提交规则，在开始新修改前处理需要保留的现有改动。

## 2. 当前架构事实

- NetHack C 核心编译为 WebAssembly，通过 `win/shim/winshim.c`、
  Emscripten Asyncify 和 `frontend/src/nethack-bridge.ts` 与 React 通信。
- `frontend/src/app/app-state.ts` 是顶层应用生命周期的唯一状态机。
- `frontend/src/session/session-manager.ts` 管理唯一活动 WASM session、module、
  callback 和清理过程。
- 每局 game module 在进入首页读取存档时创建；首页没有活动 session，也不调用
  `main()`。用户开始或继续游戏时，新 session 认领同一个 module。
- module、session 和首页之间的权威生命周期见
  `doc/BlissHack/plans/in-prealpha-2/module-lifecycle.md`。
- 项目主要在 TypeScript 侧开发，但允许对 C 侧 shim 做少量、经过源码验证且
  有测试覆盖的功能补全。
- shim ABI 有已知限制。不得假定它能无损表达全部 `window_procs` 契约，也不得
  猜测未公开的 WASM 地址或结构布局。
- `frontend/public/nethack.js`、`frontend/public/nethack.wasm` 和
  `frontend/public/nethack-runtime.json` 是必须一起更新的运行时三件套。

## 3. 按任务读取

### React、界面或应用状态

读取：

- `frontend/package.json`
- `frontend/README.md`
- `frontend/src/App.tsx`
- `frontend/src/app/app-state.ts`
- `frontend/src/session/session-manager.ts`
- 任务相关 screen、辅助模块及同目录测试

先检查现有组件和 CSS 约定，不另建重复状态或生命周期管理器。

### shim、WASM 或 C/TypeScript 桥接

读取：

- `sys/libnh/README.md`
- `doc/window.txt` 的相关接口段落
- `doc/BlissHack/shim-interface-reference.md` 的勘误、目标接口和
  “当前项目对 shim 接口的修改”章节
- `win/shim/winshim.c`
- `sys/libnh/libnhmain.c`
- `frontend/src/nethack-bridge.ts` 及其测试

文档与行为冲突时必须检查实际 C 调用链。只有能确认文档过时，才以当前代码为准。

### 游戏规则或玩家交互

先用 `doc/BlissHack/guidebook-index-cn.md` 定位章节，再分段读取
`doc/Guidebook.txt`。涉及行为差异时同时检查对应 C 源码，不把索引文档当作
最终规范。

### WASM 构建

读取：

- `doc/BlissHack/build-process.md`
- `sys/unix/hints/include/cross-pre2.500`
- `frontend/scripts/verify-runtime-assets.mjs`
- `doc/BlissHack/upstream-modifications.md`

重新构建后必须验证并一起更新运行时三件套。

### GitHub Pages 和 CI

读取：

- `.github/workflows/deploy-pages.yml`
- `frontend/package.json`
- `frontend/vite.config.ts`

不要根据 README 猜测 workflow 的分支、路径或触发条件。

### 存档与 IDBFS

读取：

- `doc/BlissHack/plans/prealpha-2.md` 的阶段二至四相关部分
- `doc/BlissHack/plans/in-prealpha-2/save-format-review.md`
- `doc/BlissHack/plans/in-prealpha-2/module-lifecycle.md`
- `sys/libnh/README.md`
- 当前 storage 实现和测试
- NetHack 保存、恢复调用链的相关 C 源码

阶段二的浏览器内存储和读取方案评审是强制门禁；获得用户确认前不得实现
存档列表元数据或继续游戏。导入、导出和覆盖策略在阶段三开始前另行评审。

## 4. 修改与验证

- 修改前先搜索调用点和现有测试，优先复用当前模块边界。
- 新函数按项目约定说明用途、参数和返回值；代码注释使用英文。
- 修改上游 NetHack 文件时，在文件中显著注明修改者、日期和目的，并更新 shim
  修改记录。
- 测试范围按风险决定。普通前端改动至少运行相关单元测试、lint 和生产构建；
  shim/WASM 改动还必须重新编译 WASM，并运行 WASM 与浏览器集成测试。
- 完成后运行 `git diff --check` 并报告实际执行的测试。
- 除非用户明确要求提交，否则实现完成后保留改动供审核。
