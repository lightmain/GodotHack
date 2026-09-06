# prealpha-3 阶段四：多页面游戏锁设计评审

## 1. 文档状态

本文是 prealpha-3 阶段四的设计评审和分步实施计划，当前等待用户确认。
确认前不修改前端运行时代码。

本文以已经完成的阶段三实现为基线。阶段四只修改 TypeScript、React、测试和
文档，不修改 NetHack C、shim 或 WebAssembly 运行时三件套。

本阶段需要确认的核心决定是：

1. 锁名固定为 `blisshack.active-game-and-storage`，所有受保护操作请求
   exclusive lock。
2. 锁请求使用 `ifAvailable: true`，不在浏览器锁队列中无限等待；冲突立即
   显示可重试对话框。
3. 游戏 session 持有长期 lease，短数据操作只在刷新、执行和提交结果期间
   持锁；任何需要玩家确认的 modal 都不持锁等待。
4. 获得锁后，涉及存档的操作先从 IndexedDB 重新 populate 并枚举，涉及
   profile 的操作先重新读取 `localStorage`。
5. 备份预览和最终导入分两次请求锁。最终导入发现数据已变化时重新生成预览，
   要求玩家再次确认，不按旧预览写入。
6. Web Locks API 缺失时明确 warning，并维持现有单页面行为；不实现心跳、
   超时、`BroadcastChannel` 或强制夺锁。

## 2. 已确认的当前实现

### 2.1 单页面生命周期

`frontend/src/session/session-manager.ts` 当前管理一个 prepared module 和最多
一个活动 session。Home 启动时：

1. 创建 module。
2. 把 `/save` 挂载为 IDBFS。
3. 执行一次 `syncfs(true)`。
4. 枚举存档并保存为 `HomePreparation.saves`。

New Game 或 Continue 认领该 module，调用一次 `main()`。正常退出时先 flush，
再清理 callback 和旧 module，最后创建下一 module。

当前 `homeOperationPromise` 只串行化同一页面中的 session 启动、raw save、
完整备份和清除操作。它不能阻止另一个页面使用自己的 module 同时读写同一个
IndexedDB。

### 2.2 过期文件系统视图

每个页面的 Emscripten module 都有独立 MEMFS。两个页面可以先后 populate
同一个 IDBFS，然后长期保留不同的 `/save` 内存快照。

因此只在写入或 `main()` 前获取 Web Lock 仍然不够。获得锁的页面必须再次执行
`syncfs(true)`，然后重新枚举。否则它可能：

- Continue 已被另一页面替换或删除的旧存档。
- 用旧存档列表生成 New Game 的已占用角色名集合。
- 导出另一页面保存前的旧 bytes。
- 用旧 MEMFS flush 覆盖另一页面刚提交的内容。

### 2.3 profile 绕过 session manager

当前 profile 由 `ProfileProvider` 直接读写：

```text
localStorage["blisshack.profile.v1"]
```

Home Settings 的 Apply、Restore Defaults、Import Profile 和 Export Profile
不经过 `session-manager`。完整备份导出接收 React 内存中的 profile，完整备份
导入后的 profile 应用也直接调用 `replaceProfile()`。

阶段四必须把这些入口接入同一把锁。游戏内 Settings 已处于长期 session lease
内，不得嵌套请求同名锁。

### 2.4 teardown 的现有风险

当前 `dispose()` 即使在 Home 没有活动 session，也会 flush prepared module。
多页面下，这个 module 可能持有过期快照，页面卸载时 flush 会覆盖其他页面的
新数据。

阶段四后：

- idle Home module 的 dispose 只废弃内存状态，不 flush。
- 活动 session 的正常退出和可控 fatal 清理在长期 lease 内完成必要 flush。
- 页面关闭或浏览器崩溃依靠浏览器释放 Web Lock；不增加 unload 心跳或
  “最后一次强制 flush”。

## 3. 目标、非目标和不变量

### 3.1 目标

- 支持 Web Locks API 时，同一来源同一浏览器配置最多有一个活动游戏 session。
- 游戏和短数据操作不能并发访问共享持久数据。
- 锁冲突是可恢复状态，不创建 session、不调用 `main()`、不进入 fatal。
- 锁释放后，玩家可以对原操作点击 `Try Again`。
- 不支持 Web Locks API 时，应用仍能按现有单页面方式运行。

### 3.2 非目标

- 不跨浏览器配置、隐私上下文、不同来源或不同设备互斥。
- 不检测哪个具体页面持锁，不显示页面标题、URL 或剩余时间。
- 不保证崩溃前未保存的游戏进度。
- 不解决玩家主动清除网站数据或浏览器破坏 IndexedDB 的情况。
- 不实现排队进度、后台轮询、强制夺锁或锁超时。

### 3.3 必须保持的不变量

1. 一个 game module 最多运行一个 session。
2. `main()` 只能在获得长期 lease 且刷新持久存储后调用。
3. session 的保存、退出 flush、callback 清理和 module 退休完成前不释放锁。
4. 短操作在锁内重新读取权威数据，不使用锁前缓存决定写入内容。
5. 任何确认 modal、文件选择器或下载后的用户交互都不占用锁。
6. 同一页面仍由本地 operation gate 串行；跨页面由 Web Lock 保证不重叠。
7. 诊断日志不记录角色名、文件名、profile 内容或锁持有页面信息。

## 4. Web Locks 适配器

### 4.1 固定协议

新增：

```text
frontend/src/concurrency/game-lock.ts
```

锁名：

```text
blisshack.active-game-and-storage
```

所有请求使用：

```ts
{
  mode: "exclusive",
  ifAvailable: true
}
```

不使用 `steal`、`navigator.locks.query()` 或没有上限的排队请求。
`ifAvailable` 回调收到 `null` 表示锁冲突；这与 API 缺失、API 抛错和受保护
操作自身失败是四种不同结果。

### 4.2 窄接口

适配器提供两种能力：

```ts
interface GameLock {
  support(): "supported" | "unsupported";
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  acquireLease(): Promise<GameLockLease>;
}

interface GameLockLease {
  release(): Promise<void>;
}
```

- `runExclusive()` 用于短操作。回调完成或抛错时浏览器自动释放锁。
- `acquireLease()` 用于游戏 session。内部 Web Lock callback 等待一个私有
  deferred Promise；`release()` 只结算一次，并等待浏览器 request 完成。
- 冲突抛出稳定的 `GameLockConflictError`。
- Web Locks API 存在但 `request()` 抛错时抛出
  `GameLockRequestError`，不能降级成 unsupported 后无锁执行。
- API 缺失时两个方法直接执行现有单页面路径；`acquireLease()` 返回 no-op
  lease。

适配器只负责浏览器锁，不知道 React、module、IDBFS 或 profile。

### 4.3 诊断

增加以下稳定事件：

```text
game_lock.unsupported
game_lock.conflict
game_lock.request_failed
game_lock.session_acquired
game_lock.session_released
```

`game_lock.unsupported` 每次页面加载最多记录一次。冲突事件可以记录操作类别：

```text
new-game
continue-game
raw-save-import
raw-save-export
raw-save-delete
profile-save
profile-import
profile-export
full-backup-preview
full-backup-import
full-backup-export
clear-local-data
```

不记录锁的客户端 ID、URL、页面标题、角色名或文件名。短锁不为每次成功都写
acquired/released 事件，避免诊断日志被普通 Settings 操作淹没。

## 5. 锁所有权和操作矩阵

| 操作 | 是否持锁 | 锁内刷新 | 锁释放点 |
|------|----------|----------|----------|
| Home 初始展示和打开 Settings | 否 | 无 | 不适用 |
| 导出诊断日志 | 否 | 无 | 不适用 |
| 查询或请求持久存储授权 | 否 | 无 | 不适用 |
| New Game | 长期 | IDBFS、存档列表、profile | session 完整清理后 |
| Continue | 长期 | IDBFS、存档列表、profile | session 完整清理后 |
| raw save 导入、导出、删除 | 短期 | IDBFS 和存档列表 | 操作及列表刷新完成后 |
| profile Apply / Restore | 短期或复用 session | profile | profile 发布后 |
| profile Import / Export | 短期或复用 session | profile | 提交或下载 payload 生成后 |
| 完整备份预览 | 短期 | IDBFS、存档列表、profile | 分类完成后 |
| 完整备份最终导入 | 短期 | IDBFS、存档列表、profile | 保存处理和列表刷新完成后 |
| 完整备份导出 | 短期 | IDBFS、存档列表、profile | JSON payload 完成后 |
| 清除本地数据 | 短期 | IDBFS、profile、diagnostics | 清除并准备干净 module 后 |

Profile 文件的纯 UTF-8/JSON 校验、备份文件的 Base64/SHA-256 容器校验可以在
请求锁前完成，因为它们只处理用户选择的 bytes。任何依赖当前 `/save` 或
`localStorage` 的分类、差异计算和提交必须在锁内重新执行。

下载动作本身在锁外使用已经生成的不可变 payload。这样浏览器下载 UI 不会延长
锁生命周期。

## 6. 锁内刷新协议

### 6.1 IDBFS

`StorageService` 增加显式刷新操作：

```ts
refreshFromPersistent(): Promise<SaveListEntry[]>
```

行为：

1. 等待该 service 先前的 sync queue。
2. 已挂载 IDBFS 时执行 `syncfs(true)`。
3. populate 成功后重新枚举并校验正式存档。
4. 用新列表替换 `HomePreparation.saves` 并通知 React。
5. populate 或枚举失败时终止当前受保护操作，不使用旧列表继续。

浏览器持久存储不可用时，现有临时单页面 New Game 仍可运行；没有 IDBFS 可以
刷新，Continue 和持久文件操作继续禁用。

New Game 使用刷新后的 ready save 生成角色名占用集合。Continue 按 path 在
刷新后的列表中重新查找，并使用刷新后的 identity 和 bytes；锁前选择只表达
玩家想继续哪个正式路径，不能携带权威 bytes。

### 6.2 profile

`ProfileProvider`/`ProfileStore` 增加显式 reload 和版本比较边界。Home
Settings 打开时的 profile 作为表单 base revision。

获得锁后：

- Apply、Restore 和 Import 先重新读取 `blisshack.profile.v1`。
- 若当前持久记录与表单 base revision 不同，不覆盖新值；发布最新 profile，
  保留玩家 draft，并显示“另一页面已更新 Settings，请检查后重试”。
- Export Profile 从刚 reload 的 profile 生成文件。
- New Game、Continue 和完整备份导出使用刚 reload 的 profile，不使用闭包中
  可能过期的 React 值。

活动游戏已持有长期 lease。游戏内 Settings 和核心配置自动同步直接复用该
lease，不再次请求同名锁；否则同一页面会被自己的非重入锁阻塞。

### 6.3 破坏性操作和过期确认

不能跨用户确认长期持有短锁。删除、覆盖和备份导入采用“刷新后核对前置条件”
而不是持锁等待：

- 删除：执行前刷新；如果目标已不存在则刷新 UI 并停止。如果目标的状态、
  identity 或修改时间与用户确认时不同，要求重新确认。
- raw save 覆盖：重试覆盖时刷新并重新生成 conflict；现有目标变化时显示新
  conflict，不按旧确认覆盖。
- 完整备份：预览释放锁。最终确认时重新刷新并重新分类；分类、同名冲突或
  profile 差异变化时返回新预览，不写入任何存档，要求玩家再次确认。
- 清除本地数据：确认文本只表达清除全部 BlissHack 数据的意图；获得锁后重新
  统计并以最新数据创建补偿快照，可以直接执行，无需按旧数量再次确认。

## 7. session 长期 lease

### 7.1 启动顺序

New Game 和 Continue 统一执行：

```text
同页面 Home operation gate
  -> try acquire exclusive lease
  -> 冲突则返回 GameLockConflictError
  -> refresh IDBFS and save list
  -> reload profile
  -> validate selected operation against refreshed state
  -> install runtime .nethackrc
  -> create SessionRecord and attach lease
  -> register callback
  -> call main() exactly once
```

锁冲突或锁请求失败时：

- 不创建 `SessionRecord`。
- 不注册 callback。
- 不安装依赖旧 profile 的运行时配置。
- 不调用 `main()`。
- 清除本次 `startPromise`，允许 Try Again。

### 7.2 释放顺序

正常退出：

```text
main completes
  -> final storage flush
  -> remove callback
  -> reset bridge state
  -> retire old module
  -> release lease
  -> create and populate next Home module
```

下一 Home module 可以在 release 后创建，因为它只做只读 populate。不能在锁
释放后继续对旧 module flush。

可控 fatal：

```text
finish required rollback/flush when still safe
  -> remove callback and isolate module
  -> release lease
  -> show fatal state
```

锁本身的 release 失败只表示适配器实现或浏览器异常，记录
`game_lock.request_failed`；不能再次调用 `main()` 或把旧 session 恢复成
running。

页面关闭或浏览器崩溃时，Web Locks API 自动释放锁。本版本不承诺异步 React
cleanup 或 unload flush 一定完成。

## 8. 短操作协调

现有 `homeOperationPromise` 保留，扩展为统一的本页 operation gate。固定顺序
为：

```text
进入本页 gate
  -> 请求 Web Lock
  -> 刷新所需权威数据
  -> 执行操作
  -> 提交后刷新 UI
  -> 释放 Web Lock
  -> 离开本页 gate
```

所有路径使用相同顺序，避免一个路径先持本页 gate、另一路径先持 Web Lock 所
造成的死锁。

两个页面同时发起短操作时，最多一个进入临界区。另一个因 `ifAvailable` 立即
得到冲突，并在玩家点击 `Try Again` 后重新执行，因此操作不会重叠。

完整备份导入内部逐文件事务继续只占用一次外层本页 gate 和一次 Web Lock；
内部不能递归请求锁。阶段三规定的 profile 最终应用发生在存档结果展示和玩家
单独确认之后，因此不能跨该确认持有导入锁；它作为独立 `profile-import`
短操作重新取锁并 reload profile。

### 8.1 应用集成边界

`session-manager` 持有唯一 `GameLock` 实例，并暴露受保护的 profile operation
入口。App 把 `ProfileProvider` 的 reload、replace 和导出 payload 生成作为
callback 传入，manager 不直接依赖 React context 或 `localStorage`。

- Home profile operation：进入本页 gate，获取短锁，再调用 profile callback。
- 游戏内 profile operation：确认当前 session 持有 live lease 后直接调用
  callback，不请求第二把同名锁。
- session start：锁内调用 profile reload callback，并把返回值用于安装 rc；
  `SessionStartRequest` 中锁前捕获的 settings 不再是权威值。
- 完整备份导出：锁内同时取得刷新后的 saves 和 reload 后的 profile，再生成
  一个不可变 JSON payload。

React screen 只接收异步业务 callback，不持有 `GameLockLease`，也不根据错误
字符串判断冲突。这样所有锁释放路径仍集中在 manager 和适配器。

## 9. UI 和可访问性

### 9.1 不支持提示

Home 在 Web Locks API 缺失时显示：

```text
This browser cannot protect games opened in multiple BlissHack pages.
Use only one page at a time.
```

该 warning 不禁用 New Game、Continue、Settings 或存档操作。支持情况只按
运行时 API 检测，不按浏览器名称或 user agent 判断。

### 9.2 锁冲突对话框

新增一个应用级 modal：

- 标题：`BlissHack is busy in another page`
- 正文：说明另一 BlissHack 页面正在运行游戏或修改本地数据。
- 操作：`Try Again`、`Cancel`

行为：

- 保存原操作的不可变参数；Try Again 重新走完整的申请锁和刷新流程。
- 重试期间禁用两个按钮，避免重复请求。
- 再次冲突时保持 dialog，不增加倒计时或自动轮询。
- Cancel 丢弃待重试操作，不改变 module、profile 或存档。
- 打开时焦点进入 dialog，Tab/Shift+Tab 保持在内，Esc 等同 Cancel。
- 关闭后焦点回到最初触发按钮；成功开始游戏时不恢复 Home 焦点。
- 普通 operation error 和 stale-data error 使用各自现有错误 UI，不伪装成
  锁冲突。

应用同一时间只保留一个待重试操作。React 页面因成功操作切换、fatal 或卸载
时清除它。

## 10. 不支持 Web Locks API

检测条件是 `navigator.locks` 及其 `request` 方法是否存在。

不支持时：

1. Home 显示第 9.1 节 warning。
2. 记录一次 `game_lock.unsupported`。
3. 适配器直接执行原单页面逻辑。
4. 仍执行本页 operation gate 和现有 storage queue。
5. 不创建 localStorage 锁记录，不使用 IndexedDB 时间戳，不发送
   `BroadcastChannel` 心跳。

这是明确降级，不提供跨页面安全承诺。持久存储 API 是否支持与 Web Locks
支持情况分别展示，二者不能共用状态。

## 11. 错误分类

- `GameLockConflictError`：可恢复 warning，显示 Try Again/Cancel。
- Web Locks API 存在但 request 同步抛错或 Promise rejected：可恢复 operation
  error，记录 `game_lock.request_failed`。
- 获锁后的 IDBFS refresh 失败：沿用 storage 可恢复错误；不执行目标操作。
- session 已创建后的刷新、配置安装、main 或 flush 失败：沿用现有 module/
  session fatal 规则，但先完成 lease 清理。
- profile base revision 过期：可恢复 stale-data 状态，刷新 profile 并要求
  玩家重新检查。
- 备份最终导入预览过期：返回新预览，不写数据，不计为单文件失败。
- release 重复调用：幂等，不重复记录或结算。

锁冲突本身不改变 `storageAvailable`，不进入 fatal，也不创建新的 game module。

## 12. 代码职责和预计文件

新增：

```text
frontend/src/concurrency/game-lock.ts
frontend/src/concurrency/game-lock.test.ts
frontend/src/screens/GameLockConflictDialog.tsx
frontend/src/screens/GameLockConflictDialog.test.tsx
frontend/test/integration-tests/browser/multi-page-lock.spec.ts
```

修改：

```text
frontend/src/storage/storage-service.ts
frontend/src/settings/profile-store.ts
frontend/src/settings/profile-context.ts
frontend/src/settings/ProfileProvider.tsx
frontend/src/session/session-manager.ts
frontend/src/app/app-state.ts（仅在全局冲突状态确有必要时）
frontend/src/App.tsx
frontend/src/screens/HomeScreen.tsx
frontend/src/screens/SavePickerPopover.tsx
frontend/src/screens/SettingsScreen.tsx
frontend/src/screens/DataManagementSection.tsx
frontend/src/screens/GameScreen.tsx
frontend/src/diagnostics/diagnostic-log.ts
frontend/src/App.css
对应单元测试
```

职责划分：

- `game-lock.ts`：浏览器 API 检测、短锁、lease、稳定错误类型。
- `storage-service.ts`：锁内 populate 和重新枚举，不感知 Web Lock。
- profile store/provider：reload、base revision 和原子替换，不感知 modal。
- session manager：本页 gate、锁顺序、session lease、存档刷新和清理。
- App：把 profile 操作接入 session manager，保存待重试 command。
- React screens：pending、冲突 dialog、stale preview 和焦点，不直接调用
  `navigator.locks`。

本阶段不修改：

```text
win/shim/winshim.c
frontend/public/nethack.js
frontend/public/nethack.wasm
frontend/public/nethack-runtime.json
```

## 13. 测试设计

### 13.1 锁适配器单元测试

- 支持时使用固定名称、exclusive 和 `ifAvailable: true`。
- callback 收到 null 时抛出 `GameLockConflictError`，且不调用 operation。
- 短 operation resolve、reject 和 throw 后都释放锁。
- lease 在 `release()` 前保持 request callback pending。
- release 幂等，request 失败与 operation 失败不被误报成 conflict。
- API 缺失时执行 no-op 降级并只报告一次 unsupported。

### 13.2 storage 和 session manager 测试

- 获锁后、任何存档读取或写入前执行 `syncfs(true)` 和重新枚举。
- New Game 使用刷新后的角色名集合。
- Continue 使用刷新后的 save；已删除或变为 incompatible 时不调用 `main()`。
- 锁冲突时不创建 session、不注册 callback、不调用 `main()`。
- rc 安装失败和 main 同步失败都释放 lease。
- 正常退出在最终 flush 和 callback 清理后释放 lease。
- fatal 清理和 restore rollback 完成后释放 lease。
- idle Home dispose 不 flush 过期 module。
- raw save 和完整备份操作在刷新后执行，结束前不释放短锁。
- 两个同页短操作仍串行，内部批量导入不递归取锁。

### 13.3 profile 和 React 测试

- Home Apply、Restore、Import、Export 都经过短锁。
- 游戏内 Settings 复用活动 lease，不嵌套请求。
- profile revision 变化时不覆盖新记录，保留 draft 并提示重新检查。
- 完整备份导出使用锁内 reload 的 profile。
- 备份预览变化时最终导入不写文件并返回新预览。
- unsupported warning 只在 Home 显示且不禁用命令。
- 冲突 dialog 的名称、初始焦点、焦点循环、Esc、Cancel 和焦点恢复正确。
- Try Again 防重复点击，并完整重跑刷新和前置条件校验。

### 13.4 Chromium 双页面集成测试

使用同一个 Playwright `BrowserContext` 打开两个 page：

1. 第一页开始游戏并停在活动 session；第二页 New Game 显示锁冲突。
2. 第二页诊断证明没有 `session.created` 和 `wasm.main_started`。
3. 第一页保存退出；第二页点击 Try Again 后成功进入名字输入。
4. 第一页活动游戏期间，第二页 raw import/export/delete、profile
   import/export、完整备份 import/export 和清除均不能访问持久数据。
5. 第一页进入可控 fatal 并完成清理后，第二页重试能够开始游戏。
6. 两页先加载 Home，第一页产生并保存新存档；第二页随后 Continue 时必须先
   刷新并看到新存档，不能使用初始旧列表。
7. 两页竞争短操作时不会重叠；失败页重试后使用第一页提交后的数据。
8. 删除 `navigator.locks` 后 Home 显示 warning，单页面 New Game、保存、
   Continue 和 raw export 仍通过。

双页面测试不使用浏览器名称推断支持情况。测试开始时先断言当前 Chromium
实际暴露 Web Locks API。

## 14. 分步实施计划

每一步保持构建通过，并作为独立审核点。阶段四不需要重建 WASM。

### 步骤一：锁适配器和诊断

- 实现固定锁名、短锁、长期 lease 和错误分类。
- 增加可注入 `LockManager` 的单元测试。
- 增加 unsupported 一次性诊断。

验收：

- available、conflict、unsupported、request throw/reject 全部分离。
- lease 只在显式 release 后结束，重复 release 安全。

### 步骤二：锁内 storage 刷新

- 为 storage service 增加 populate + enumerate 刷新。
- 让 Home preparation 可以原子替换为刷新结果。
- 删除 idle Home dispose flush。
- 为过期列表、刷新失败和 stale operation 增加测试。

验收：

- 受保护操作不读取锁前 MEMFS 快照。
- 刷新失败时目标操作没有副作用。

### 步骤三：session 长期 lease

- 在 session 启动前获取 lease。
- 刷新存档和 profile 后再安装 rc、创建 session 和调用 `main()`。
- 把 lease 绑定到 `SessionRecord`，接通正常退出、fatal、启动失败和 dispose。

验收：

- 冲突页没有 session 或 `main()`。
- 锁覆盖 session 的全部保存和清理生命周期。
- 第一页退出或 fatal 清理后第二页可重试。

### 步骤四：Home 文件和备份短操作

- 把 raw save、完整备份和清除接入统一短锁。
- 拆分备份的纯文件校验与锁内当前存储分类。
- 最终导入重新分类，过期预览不写入。
- 删除和覆盖增加锁内 stale 前置条件检查。

验收：

- 所有存档读取、写入和导出都发生在锁与刷新之后。
- 冲突和过期确认不会产生部分写入。
- 批量导入只请求一次外层锁。

### 步骤五：profile 操作和冲突 UI

- 增加 profile reload/base revision。
- Home 与游戏内 Settings 分别使用短锁和已有 session lease。
- 接通 Profile Import/Export、Restore、完整备份 profile 和自动同步。
- 增加全局 Try Again/Cancel dialog 与 Home unsupported warning。

验收：

- 另一页面运行游戏时，所有要求保护的 profile 操作显示冲突。
- 过期 draft 不静默覆盖较新的 profile。
- dialog 键盘与焦点行为通过组件测试。

### 步骤六：双页面浏览器测试

- 新增 `multi-page-lock.spec.ts`。
- 覆盖 session 竞争、退出释放、fatal 释放、数据操作冲突、锁后刷新和
  unsupported 降级。
- 保留现有单页面浏览器流程作为回归测试。

验收：

- 同一 Chromium context 中任何时刻最多一个受保护临界区。
- Try Again 只在锁释放后执行原操作。
- 不支持 API 的模拟环境仍能完成基础单页面流程。

### 步骤七：阶段四综合验收

执行并记录：

```bash
cd frontend
npm run lint -- --deny-warnings
npm test
npm run build
npm run test:integration:wasm
npm run test:integration:browser
npm run test:long
git diff --check
```

阶段四没有 C 或 WASM 修改，因此不运行 WASM 重建命令；真实 WASM 集成测试
仍需通过。完成后更新 `prealpha-3.md` 的阶段四结果，保留实现改动供用户审核，
用户确认后再提交阶段实现。

## 15. 本次评审需要确认的决定

1. 使用 `ifAvailable: true` 立即报告冲突，不让页面在浏览器锁队列中等待。
2. session 使用长期 lease；短操作只覆盖刷新、执行和提交，不跨 modal 持锁。
3. 所有存档操作获得锁后必须重新 populate 和枚举；失败时不用旧快照继续。
4. Home profile 操作增加 base revision，发现另一页面更新时要求重新检查，
   不执行 last-writer-wins 覆盖。
5. 备份最终导入重新分类；预览过期时不写入并要求再次确认。
6. idle Home 页面卸载不再 flush prepared module。
7. Web Locks API 缺失时只 warning 并无锁降级，不实现任何伪锁。
8. 持久存储授权和诊断日志导出不取游戏锁；阶段四明确列出的其他 profile、
   save、backup 和 clear 操作均取锁。
