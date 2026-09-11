# BlissHack prealpha-4 代码重构计划

## 1. 版本目标

prealpha-4 是一个范围受限的纯代码重构版本。它不增加玩家功能，而是在
prealpha-1 至 prealpha-3 已经建立的产品行为和测试基线之上，降低前端代码的
修改范围、模块耦合和 Agent 每次任务需要读取的上下文。

本项目没有传统 release、tag 或安装包发布节点。部署分支经 GitHub Actions
push 后即成为线上版本；prealpha 阶段当前没有玩家用户。因此本计划不设置
独立的“发布冻结期”，但部署分支上的每个提交仍必须能够构建、测试并正常游玩。
全部重构工作在长期 `prealpha-4` 分支连续进行；每个阶段保持独立、可验收的
提交，完成整个计划后再合入并 push 到部署分支。

prealpha-4 的工作量应明显小于 prealpha-2 和 prealpha-3。它只整理当前已经
验证的 TypeScript、React 和 CSS，不借重构之名加入新功能或重新设计产品。

## 2. 当前基线和必要性

截至 2026-09-11，主要前端大文件为：

| 文件 | 行数 | 当前职责 |
|------|-----:|----------|
| `frontend/src/App.css` | 2049 | Home、Settings、Game、modal、响应式样式 |
| `frontend/src/session/session-manager.ts` | 1699 | module、session、锁、存档、备份、清理和错误生命周期 |
| `frontend/src/nethack-bridge.ts` | 1418 | Emscripten 类型、module 加载、ABI 解码、输入等待和 shim 分发 |
| `frontend/src/screens/GameScreen.tsx` | 1193 | 游戏壳、地图、状态、输入、暂停和全部游戏 modal |
| `frontend/src/screens/SettingsScreen.tsx` | 1071 | draft、字段区、profile 导入导出和 modal |
| `frontend/src/screens/DataManagementSection.tsx` | 789 | 持久存储、完整备份、清除数据和三个 modal |

行数本身不是拆分理由。当前真正需要处理的是：

1. `App.css` 和几个 screen 已有稳定、清晰、可单独命名的功能边界，但仍集中在
   单个文件中，导致局部界面修改需要读取大量无关代码。
2. `nethack-bridge.ts` 同时包含纯 ABI 解码和有状态输入流程，修改一个 callback
   容易扩大审查范围。
3. `session-manager.ts` 的职责较多，但它们共享严格的 module、session 和锁
   所有权。直接移动函数会把文件内闭包耦合变成更难追踪的跨文件耦合。
4. 测试覆盖已经足以支撑渐进重构，但部分测试文件仍按历史阶段命名，而不是按
   当前职责命名。

因此 prealpha-4 有明确收益，但必须从低风险的样式和 React 组件开始，最后才
处理 bridge 和 session 生命周期。

## 3. 范围边界

### 3.1 本版本包含

- 按页面职责拆分 `App.css`，保持原有选择器、层叠顺序和响应式行为。
- 拆分 `SettingsScreen.tsx`、`DataManagementSection.tsx` 和
  `GameScreen.tsx` 中已经形成独立边界的组件。
- 抽取 `nethack-bridge.ts` 中的 Emscripten 类型、module 加载、存档校验、
  纯 ABI 解码和输入控制职责。
- 为 `session-manager.ts` 建立显式内部 context，再分离 Home 数据操作与
  active session 生命周期。
- 保留现有公开入口作为 façade，避免无关调用方和测试一次性迁移。
- 按当前职责重组大测试文件，并补充重构所需的 characterization tests。
- 更新架构文档、目录说明和 Agent session 启动资料。

### 3.2 本版本不包含

- 新的游戏功能、设置项、页面、动画或视觉设计。
- 修改 NetHack C 源码、shim ABI、能力位或 Asyncify 行为。
- 重新构建或修改 `nethack.js`、`nethack.wasm`、
  `nethack-runtime.json`。
- 修改 profile schema、storage key、备份格式或 raw save 格式。
- 引入 React Router、状态管理框架、CSS-in-JS、CSS Modules 或新的测试框架。
- 为追求行数目标建立只有一个调用者的通用工具层。
- 重写已经稳定的 `app-state.ts`、`game-state.ts` 或
  `storage-service.ts`。
- 顺便修复与文件拆分无关的产品问题。发现的缺陷应先独立记录，再用单独提交
  修复。

## 4. 重构原则

1. **行为保持**：每一步都必须是可证明的无行为变化重构。
2. **按职责拆分**：不以固定行数为目标；一个文件应有一个可用一句话说明的
   主要职责。
3. **稳定 façade**：现有调用方先继续从 `nethack-bridge.ts`、
   `session-manager.ts` 和现有 screen 路径导入。
4. **单系统提交**：一个提交只处理 CSS、一个 screen、bridge 或 session 中的
   一个，不跨多个高风险边界。
5. **先纯后有状态**：先抽取类型、常量和纯函数，再移动依赖生命周期状态的
   逻辑。
6. **显式依赖**：跨文件函数通过参数或内部 context 获取 module、session、
   diagnostics 和 lock，不读取新增的模块级可变全局。
7. **不制造 `utils.ts`**：模块名称必须表达领域职责；只有确有多个调用者时才
   抽共享组件。
8. **测试随职责移动**：实现拆分后，测试按同一领域拆分，不保留只反映历史
   开发阶段的文件名。
9. **部署分支持续可用**：`prealpha-4` 分支上的重构未完成前不合入部署分支；
   最终合入时的每个 commit 都必须满足对应阶段门禁。

## 5. 阶段一：样式按页面拆分

### 5.1 目标结构

```text
frontend/src/styles/
├── shared.css
├── home.css
├── settings.css
└── game.css
```

`App.css` 保留为唯一的聚合入口，按 `shared`、`home`、`settings`、`game`
的固定顺序导入。各 screen 不直接导入这些全局样式，避免组件加载顺序改变
CSS 层叠结果。`index.css` 继续只负责根元素和浏览器基础样式。

### 5.2 实施要求

- 先按现有连续代码块原样移动规则，不同时重命名 class。
- 把每个 media query 中的规则移动到所属页面文件。
- Home、save picker 和 fatal 共用的应用壳样式放入 `home.css`。
- Settings、profile、backup 和 Settings modal 放入 `settings.css`。
- terminal、永久背包、游戏 modal 和颜色类放入 `game.css`。
- 保持最终 CSS 注入顺序和当前层叠结果。

### 5.3 验收

- `npm run lint`
- `npm test`
- `npm run build`
- Settings、Home、save picker、游戏画面的桌面和窄视口截图无差异。
- Chromium 浏览器基础流程通过。

### 5.4 实施结果

阶段一于 2026-09-11 在 `dev/prealpha-4-stage-1` 分支完成：

- `App.css` 缩减为 4 行固定顺序的 `@import` 聚合入口。
- 新增 `shared.css`、`home.css`、`settings.css` 和 `game.css`，分别为
  5、641、731 和 671 行。
- 原有 CSS 选择器和声明保持不变；末尾混合的 700px media query 只按 Home
  与 Game 归属拆成两个等价区块。
- 删除 `GameScreen.tsx` 对 `App.css` 的重复导入，由 `App.tsx` 统一加载。
- `VERSION`、README 和 Agent session 启动入口切换到 `prealpha-4`；备份和
  profile 测试中的 `prealpha-3` 历史 fixture 保持不变。
- 拆分前后分别截取 Home、Settings 顶部、Settings 底部和永久背包 harness
  的桌面及窄视口图片，共 8 组；归一化版本文字后 PNG 字节完全一致。
- `npm run lint`、407 个单元测试、`npm run build`、35 个 Chromium
  浏览器测试以及 12 个 Firefox/WebKit 基础测试全部通过。

现有测试已经覆盖 CSS 入口、各主要页面和响应式交互，像素基线又能直接证明
机械拆分没有改变渲染，因此本阶段没有新增长期维护的截图测试。

## 6. 阶段二：Settings 和数据管理组件

### 6.1 目标结构

保持 `screens/SettingsScreen.tsx` 为公开入口，在其下增加：

```text
frontend/src/screens/settings/
├── DataManagementControls.tsx
├── DataManagementDialogs.tsx
├── SettingsControls.tsx
├── SettingsSections.tsx
├── SettingsDialogs.tsx
└── SettingsModal.tsx
```

### 6.2 拆分顺序

1. 抽取 `ToggleField`、`SegmentedField` 等纯展示控件。
2. 抽取 Interface、Inventory 和 NetHack 三个字段区；通过明确的
   `onInterfaceChange`、`onNetHackChange` 回调修改 draft。
3. 抽取 profile 导入预览和确认 dialog。
4. 为 Settings 与 Data Management 的 modal 补充焦点恢复
   characterization tests。
5. 只有两种 modal 的取消、`inert` 和焦点恢复契约一致后，才共用
   `SettingsModal`；不能只因 JSX 相似就合并。
6. 将完整备份结果、预览和清除确认从 `DataManagementSection.tsx` 抽为独立
   dialog，section 本身保留工作流状态。

`SettingsScreen.tsx` 最终只负责 draft、提交、profile 文件操作和页面组合。

### 6.3 验收

- Home 和游戏内 Settings 的字段、默认值和生效路径不变。
- modal 的初始焦点、Tab 循环、Esc、背景 `inert` 和返回焦点不变。
- profile、backup 和 clear data 流程的单元及浏览器测试通过。
- 不修改 profile 类型、校验器或持久化格式。

### 6.4 实施结果

阶段二于 2026-09-11 在长期 `prealpha-4` 分支完成：

- `SettingsScreen.tsx` 从 1071 行缩减到 497 行，只保留 draft、提交、
  profile 文件操作、Data Management 接线和页面组合。
- `DataManagementSection.tsx` 从 789 行缩减到 382 行，保留持久化、备份导入
  导出、清除数据和 profile 应用工作流。
- 字段区、基础控件、Profile 操作、Data Management 操作及五个 dialog
  分别迁入 `screens/settings/` 下的职责文件。
- Settings 和 Data Management 共用唯一的 `SettingsModal`，统一初始焦点、
  Tab 循环、Esc、背景 `inert` 和返回焦点行为。
- 新增 Data clear dialog 的 Esc 返回焦点特征测试；该测试在抽取前后均通过。
- profile 类型、校验器、持久化 key 和导入导出格式均未修改。
- 8 组阶段一/阶段二页面截图逐字节一致。
- `npm run lint`、407 个单元测试、`npm run build`、35 个 Chromium
  浏览器测试及 12 个 Firefox/WebKit 基础测试全部通过。

## 7. 阶段三：游戏界面组件

### 7.1 目标结构

保持 `screens/GameScreen.tsx` 为公开入口，在其下增加：

```text
frontend/src/screens/game/
├── GameTerminal.tsx
├── GameModals.tsx
├── PauseOverlay.tsx
└── StatusArea.tsx
```

### 7.2 拆分顺序

1. 抽取 `PauseOverlay`。
2. 抽取 `TextOverlay`、`MenuOverlay`、`ExtendedCommandOverlay` 及菜单内
   纯辅助函数。
3. 抽取消息、地图、状态和输入区域；地图滚动 ref 与 ResizeObserver 保留在
   地图组件内部。
4. `GameScreen.tsx` 保留 profile/runtime settings 同步、顶层键盘路由和页面
   组合。

不建立一个接收整个 `GameSnapshot` 的万能组件。每个子组件只接收它渲染或
交互所需的最小字段。

### 7.3 验收

- 地图 memo 边界、行引用稳定性和跟随玩家行为不变。
- 普通菜单、文本窗口、扩展命令、位置输入和行输入行为不变。
- 暂停、Settings、Save and Exit 和永久背包焦点行为不变。
- GameScreen 单元测试、输入测试和相关浏览器流程通过。

## 8. 阶段四：NetHack bridge

### 8.1 目标结构

`nethack-bridge.ts` 继续作为公开 façade，内部逐步拆分为：

```text
frontend/src/bridge/
├── emscripten-module.ts
├── save-validation.ts
├── shim-decoders.ts
└── input-controller.ts
```

### 8.2 拆分顺序

1. 移动 `EmscriptenModule`、文件系统类型和 module loader。
2. 移动 save fingerprint 与 identity 校验；保持 storage 使用的类型契约。
3. 移动 glyph、status 和 extended command 等纯 WASM32 解码。
4. 用内部 `InputController` 封装 pending action、typeahead、
   save-and-exit automation 和 runtime settings queue。
5. façade 保留当前函数名，将调用委托给唯一活动 controller。
6. 最后再把 shim callback switch 按窗口、输入和状态职责分派；不能在同一步
   改 callback 名称或返回值语义。

本阶段不得猜测新的 WASM 地址、结构布局或回调语义。所有偏移继续来自当前已
验证实现和 shim 文档。

### 8.3 验收

- 现有 bridge 的 49 个单元测试按新模块职责迁移并全部通过。
- malformed callback 的安全返回值不变。
- Asyncify 同一时刻仍只存在一个 pending action。
- 永久背包更新仍不进入交互式 modal。
- `npm run test:integration:wasm` 和完整浏览器测试通过。

## 9. 阶段五：SessionManager

这是 prealpha-4 风险最高、最后执行的阶段。

### 9.1 第一步：显式内部 context

先在单文件内建立 `SessionManagerContext`，集中保存：

- 当前 module 和 session record。
- initialize、start 和 Home operation promise。
- game lock 与 session lease。
- diagnostics、dispatch 和注入依赖。
- disposed、fatal 和 unsupported-lock 状态。

原有闭包函数先改为接收同一个 context，但不移动文件。只有相关测试全部通过后
才进行跨文件拆分。

### 9.2 第二步：按所有权拆分

```text
frontend/src/session/
├── session-manager.ts
├── session-types.ts
├── home-operations.ts
└── session-lifecycle.ts
```

- `session-manager.ts`：创建 context、组合公开 API、保留兼容导出。
- `home-operations.ts`：刷新、删除、导入导出、备份和清除本地数据。
- `session-lifecycle.ts`：启动、callback 注册、flush、restore failure、
  retire、fatal 和 dispose。
- `session-types.ts`：公开类型和内部 record 类型；禁止反向导入 manager。

输入转发仍必须经过 active session 检查，不能让 screen 直接持有 bridge
controller。

### 9.3 第三步：测试按领域命名

把现有历史阶段测试逐步整理为：

```text
session-manager.home.test.ts
session-manager.lifecycle.test.ts
session-manager.lock.test.ts
session-manager.backup.test.ts
```

测试移动与实现移动保持同一提交，不一次性重写 fixture。

### 9.4 验收

- 同一页面仍只有一个 module owner 和一个 active session。
- concurrent start、stale callback、重复 cleanup 和失败恢复行为不变。
- Web Locks 的短操作锁和长 session lease 顺序不变。
- 保存退出、flush、restore rollback 和下一 module 创建顺序不变。
- 完整单元、WASM、浏览器、多页面锁和长流程测试通过。

## 10. 阶段六：收尾

1. 删除已经没有调用者的兼容内部函数，但保留已承诺的公开 façade。
2. 检查循环依赖、重复类型和跨目录深层导入。
3. 更新 `session-start.md`、README 目录说明和相关架构文档。
4. 记录重构后的文件行数和主要依赖方向，与第 2 节基线比较。
5. 运行全部自动测试和一次人工基础游玩。

本阶段不以“所有文件低于某个行数”为成功标准。建议的结果是：

- screen 入口主要负责组合，不再内嵌多个大型 modal 或完整子系统。
- `App.css` 不再要求一次读取全部页面样式。
- bridge 的纯 ABI 解码可以脱离 pending input 状态测试。
- session lifecycle 和 Home 数据操作可以分别阅读，但共享所有权仍由一个
  context 强制执行。

## 11. 提交和部署策略

建议使用独立分支：

```text
dev/prealpha-4-refactor
```

每个阶段至少形成一个独立提交。推荐顺序：

1. `chore: start prealpha-4 refactoring`
2. `refactor: split frontend styles by screen`
3. `refactor: extract settings screen components`
4. `refactor: extract game screen components`
5. `refactor: separate bridge codecs and input state`
6. `refactor: separate session manager responsibilities`
7. `docs: complete prealpha-4 refactoring`

第一项实施提交再把 `VERSION` 切换为 `prealpha-4`，并更新 README 和
`session-start.md` 的当前阶段。仅创建本计划时不提前改变线上产品版本。

由于 push 即部署：

- 未完成的阶段不合入部署分支。
- 每次准备合入前先 rebase 或 merge 最新部署分支并重新执行阶段门禁。
- 不用 tag 或 GitHub Release 作为完成依据。
- 合入部署分支并由 GitHub Actions 成功部署后，该阶段即成为线上版本的一部分。

## 12. 停止条件

出现以下情况时暂停当前重构并单独处理：

- 需要改变 shim callback、WASM 导出或 Asyncify 调用顺序。
- 需要改变 profile、backup、storage 或 save 格式。
- 必须改变玩家可见行为才能完成抽取。
- 新模块产生循环依赖，或者必须依靠新的模块级可变全局连接。
- 一个阶段无法在单独回滚时保持仓库可构建。

不能以“顺便修一下”为由把产品修改混入结构提交。

## 13. 完成定义

prealpha-4 只有同时满足以下条件才算完成：

- 第 5 至第 9 节的拆分完成，公开 façade 和产品行为保持兼容。
- 没有修改 NetHack C、shim ABI、WASM 三件套或持久化格式。
- `npm run lint`、`npm test`、`npm run build`、
  `npm run test:integration`、`npm run test:integration:compat`、
  `npm run test:performance` 和 `npm run test:long` 全部通过。
- Home、Settings、游戏、保存继续、备份、多页面锁和永久背包完成人工基础
  验收。
- 代码目录和架构文档与实际实现一致。
- 部署分支最后一次 push 的 GitHub Actions 构建和部署成功。
