# prealpha-3 阶段五：永久背包设计评审

## 1. 文档状态

本文是 prealpha-3 阶段五的设计评审和分步实施计划，当前等待用户确认。
用户确认前不得修改 `win/shim/winshim.c`、shim 能力位、运行时配置协议或
WebAssembly 运行时三件套。

阶段五在独立分支 `dev/PermanentInventory` 开发，以已经完成并合并阶段四的
`BlissHack` 分支为基线。这样永久背包可以直接复用现有 Settings、profile、
session lease 和多页面锁，不在旧基线上重复实现或手工移植阶段二至四。

本阶段建议确认以下核心决定：

1. 只为 Emscripten 版本的 shim 声明 `WC_PERM_INVENT`；原生
   `libnethack.a` shim 继续不声明消费者未协商的能力。
2. 保留 C 内同步调用 `repopulate_perminvent()` 的更新路径，不从 React 调用
   `_repopulate_perminvent`，不在 Asyncify 等待期间重入 WASM。
3. 不在本阶段实现完整 `ctrl_nhwindow()` 结构体 ABI 或 slot-based inventory；
   使用现有完整菜单重填协议。
4. 用 `MENU_BEHAVE_PERMINV` 区分永久背包与普通菜单；永久背包的
   `PICK_NONE` 同步返回 0，不打开 modal，也不创建输入 Promise。
5. 把 `perm_invent` 和 `perminv_mode` 加入现有命令边界配置协议，并把协议版本
   从 1 升为 2。
6. prealpha 阶段没有历史玩家数据，直接扩展当前 profile schema 1，不实现旧
   本地记录、旧 `.bhprofile` 或旧 `.bhbackup` 的迁移。
7. 永久背包默认关闭，模式默认 `all`；界面默认位于地图右侧，空间不足时自动
   放到地图下方。
8. 数量和装备说明只显示 NetHack 提供的完整文本，不从英文文本反向解析结构化
   状态；glyph、物品字符和菜单 flags 使用 shim 的结构化字段。
9. 本阶段保持纯展示，但已提交快照保留 revision、identifier 和 accelerator，
   以后可以在独立动作层安全编排 `d` 后选择物品等原生命令流程。

## 2. 已确认的当前实现

### 2.1 核心能力和选项

NetHack 5.0 使用以下能力和选项：

```text
WC_PERM_INVENT
perm_invent
perminv_mode
```

`perm_invent` 是可在游戏中修改的布尔选项，原生默认值为 false。
`perminv_mode` 的跨窗口端口有效值是：

| 值 | 核心枚举 | 含义 |
|----|----------|------|
| `none` / `off` | `InvOptNone` | 等同关闭永久背包 |
| `all` / `on` | `InvOptOn` | 显示除普通金币外的全部物品 |
| `full` / `gold` | `InvOptFull` | 显示包括金币在内的全部物品 |
| `in-use` / `inuse-only` | `InvOptInUse` | 只显示当前使用中的物品 |

`on+grid` 和 `gold+grid` 是 tty 专用模式。`options.c` 会在非 tty 窗口端口把
它们降级为 `all` 或 `full`，BlissHack Settings 不暴露这两个值。

### 2.2 当前 shim 是部分实现

`win/shim/winshim.c` 已有 Emscripten 专用实现：

```c
void shim_update_inventory(int arg) {
    if (iflags.perm_invent)
        repopulate_perminvent();
}
```

它直接在当前 C 调用栈内重填永久背包，避免 JavaScript 收到
`shim_update_inventory` 后再调用 `_repopulate_perminvent()` 所造成的
Asyncify 重入。

当前还存在以下限制：

- `shim_procs.wincap` 没有 `WC_PERM_INVENT`。
- Emscripten `shim_ctrl_nhwindow()` 恒返回 `NULL`。
- `shim_update_inventory()` 忽略非零参数；`#perminv` 当前只能触发一次重填，
  不能要求浏览器滚动或聚焦侧栏。
- `sys/libnh/libnhmain.c` 暴露了 `displayInventory()` helper，构建也导出了
  `_repopulate_perminvent`，但前端不能在活动回调期间安全调用它。

### 2.3 当前前端已经识别永久背包菜单

`frontend/src/nethack-bridge.ts` 已检查 `MENU_BEHAVE_PERMINV`：

1. `shim_start_menu(winid, MENU_BEHAVE_PERMINV)` 清空同一窗口的旧内容。
2. `shim_add_menu()` 复制 glyph、identifier、accelerator、attribute、color、
   text 和 item flags。
3. `shim_end_menu()` 保存标题。
4. `shim_select_menu(winid, PICK_NONE, ...)` 把该窗口记录为
   `inventoryWindowId` 并立即返回 0。

因此永久背包更新目前不会打开普通菜单 modal，也不会阻塞 Asyncify。React
尚未读取 `inventoryWindowId` 渲染侧栏。

### 2.4 当前配置协议和 profile

游戏内 Settings 已使用版本化 32-bit 协议，在 `shim_get_nh_event()` 命令边界
交换七项动态 NetHack 配置。该路径不会从 JavaScript 反向调用 C。

当前 profile schema 1 是严格封闭结构，`validateProfile()` 会拒绝未知字段和
缺失字段，持久化键为：

```text
blisshack.profile.v1
```

阶段五需要增加三个界面字段和两个 NetHack 字段。项目仍处于没有历史玩家数据
的 prealpha 阶段，schema 1 尚未形成需要维护的外部兼容承诺。本阶段直接修改
schema 1 的完整结构；旧开发数据可以失效，不增加迁移器、双 storage key 或
旧文件兼容分支。

## 3. 目标、非目标和不变量

### 3.1 目标

- NetHack 能通过正式 `WC_PERM_INVENT` 能力检查启用永久背包。
- 启用后，启动、拾取、丢弃、穿戴、卸下、数量变化和恢复存档会更新唯一侧栏。
- 普通 `PICK_ONE`、`PICK_ANY` 和非永久 `PICK_NONE` 菜单保持现有 modal 行为。
- Home 和游戏内 Settings 都能配置 `perm_invent` 与 `perminv_mode`。
- 侧栏位置和折叠状态由界面配置持久化；展开宽度由响应式布局统一控制。
- profile、个人配置文件和完整备份使用扩展后的当前 schema 1。
- 更新期间不重入 WASM，不额外消耗游戏回合，不创建第二个 session。

### 3.2 非目标

- 不为物品提供点击、右键、拖放或操作菜单。
- 不实现 `InventoryActionIntent`、通用按键宏或自动发送 `d+x` 等连续输入。
- 不解析物品英文文本来推断数量、装备槽、诅咒、材质或用途。
- 不直接遍历 `gi.invent` 或猜测 WASM 内存中的 `struct obj` 布局。
- 不实现 tty 的 grid 模式或 X11 式横向平移协议。
- 不实现通用 `ctrl_nhwindow()` WASM 结构体序列化。
- 不新增独立 inventory 查询 API。
- 不改变 raw save 格式或把 `iflags.perm_invent` 写入存档。
- 不为手机和平板设计专用永久背包交互。

### 3.3 必须保持的不变量

1. `repopulate_perminvent()` 只能由当前 C 执行流调用。
2. React 不调用 `displayInventory()`、`_repopulate_perminvent` 或其他新
   `ccall()` 来刷新背包。
3. 永久背包更新只能通过 `start_menu -> add_menu -> end_menu ->
   select_menu(PICK_NONE)` 发布。
4. `MENU_BEHAVE_PERMINV` 是永久背包身份的权威标记，不能按窗口编号、标题或
   物品文本猜测。
5. 一个 window ID 的新更新原子替换旧列表，不追加成重复侧栏。
6. session 退出、fatal 清理或 bridge reset 后不保留上一局窗口和物品。
7. profile 写入继续受阶段四同一把游戏锁保护；游戏内修改复用 session lease。
8. 每份已提交永久背包快照都有 session 内单调递增的 revision；未来动作不得
   只依赖数组索引或显示文本定位物品。

## 4. NetHack 5.0 调用链

### 4.1 启动时启用

运行时 `.nethackrc` 在 `main()` 前写入。核心启动顺序是：

```text
initoptions()
  -> parseoptions("perminv_mode:<mode>", initial=true)
  -> parseoptions("perm_invent" 或 "!perm_invent", initial=true)
  -> init_sound_disp_gamewindows()
       -> WIN_INVEN = create_nhwindow(NHW_MENU)
  -> newgame() 或 restore
  -> moveloop 初始化完成
       -> program_state.in_moveloop = 1
       -> if (iflags.perm_invent) update_inventory()
```

初始配置解析时 `go.opt_initial` 为 true，`perm_invent` 不调用
`can_set_perm_invent()`。这也是当前没有 capability 时，系统配置仍可能让
隐藏的永久背包菜单事件出现的原因。阶段五不能把这种绕过当作正式支持。

### 4.2 正常更新

物品变化调用：

```text
update_inventory()
  -> windowprocs.win_update_inventory(0)
  -> shim_update_inventory(0)
  -> repopulate_perminvent()
  -> display_pickinv(... want_reply=false)
  -> prepare_perminvent(WIN_INVEN)
  -> start_menu(WIN_INVEN, MENU_BEHAVE_PERMINV)
  -> add_menu(...) 重复零到多次
  -> end_menu(...)
  -> select_menu(WIN_INVEN, PICK_NONE, ...)
```

`display_pickinv()` 对永久背包强制走完整菜单，即使当前没有物品，也会加入
`Not carrying anything`、`Only carrying gold` 或 `Not using any items`，
因此前端可以用一次完整列表替换清除旧内容。

### 4.3 游戏内启用和模式切换

游戏中把 `perm_invent` 从 false 改为 true 时：

```text
parseoptions()
  -> can_set_perm_invent()
       -> 检查 windowprocs.wincap & WC_PERM_INVENT
       -> mode 为 none 时改为 all
  -> 设置 iflags.perm_invent
  -> 标记 redraw
  -> docrt()
       -> update_inventory()
```

在当前非 tty shim 中，`can_set_perm_invent()` 不调用
`perm_invent_toggled()`，只依赖 capability。`docrt()` 随后触发完整菜单重填。

`perminv_mode` 的原生处理会更新 mode，并在非 none 时启用
`perm_invent`。模式变化同样触发 redraw 和背包重填。

### 4.4 拒绝启用的准确行为

游戏中启用 `perm_invent` 且窗口端口没有 `WC_PERM_INVENT` 时：

1. `can_set_perm_invent()` 返回 false。
2. `parseoptions()` 返回 `optn_silenterr`。
3. `iflags.perm_invent` 保持 false。
4. 调用方按其上下文显示选项未生效，且不会创建永久背包更新。

初始 rc 解析不会经过这项检查，所以不能用“rc 中看似开启”证明窗口端口满足
契约。阶段五的真实 WASM 测试必须覆盖游戏内开关。

### 4.5 关闭和销毁

普通游戏内关闭不会销毁 `WIN_INVEN`，因为该窗口仍供核心后续使用。当前
`shim_update_inventory()` 在 `iflags.perm_invent == false` 时不发菜单事件。
因此前端必须根据下一次命令边界返回的权威配置快照立即隐藏侧栏，不能等待
窗口销毁。

游戏结束时核心会销毁 `WIN_INVEN`；`shim_destroy_nhwindow()` 使
`inventoryWindowId` 失效并停止后续更新，但前端保留最后一次已提交快照供终局
披露和墓碑流程显示。bridge reset 才清空快照和所有窗口，覆盖 fatal、启动失败
和下一局等路径。

## 5. shim 最小修改

### 5.1 能力声明

只在 Emscripten 构建中增加：

```c
#ifdef __EMSCRIPTEN__
    | WC_PERM_INVENT
#endif
```

不能无条件修改 `shim_procs.wincap`。原生 `libnethack.a` 的 shim consumer
通过任意外部 callback 实现 UI，当前没有运行时能力协商机制；无条件声明会替
所有原生 consumer 承诺它们未必实现的永久背包。

Emscripten shim 已有同步重填实现，BlissHack bridge 也已实现非阻塞
`MENU_BEHAVE_PERMINV`，所以该条件声明有具体实现支撑。

### 5.2 `ctrl_nhwindow()` 决定

本阶段不实现完整 `shim_ctrl_nhwindow()`：

- `prepare_perminvent()` 在调用 `set_mode` 前已经把 mode 写入核心侧
  `wri_info.fromcore.invmode`。
- 完整菜单内容由核心按该 mode 过滤后发送，React 不需要读取
  `win_request_info`。
- `request_settings`、`maxslot`、`too_small` 和 slot-based inventory 属于
  `sync_perminvent()` 的另一套窗口端口协商路径。
- Emscripten shim 当前通过 `shim_update_inventory()` 直接调用
  `repopulate_perminvent()`，不依赖 `maxslot`。
- 浏览器侧栏使用 DOM 自身尺寸与滚动，不需要向核心报告字符终端行列。

如果未来采用 slot-based 增量协议或需要核心控制浏览器窗口尺寸，再单独设计
带版本、长度和字段校验的 ABI。不能直接把 C 结构体地址暴露给 TypeScript。

### 5.3 `shim_update_inventory()` 和 Asyncify

保留同步 C 调用：

```text
core update_inventory
  -> shim_update_inventory
  -> repopulate_perminvent
  -> 一组 C 到 JS 的菜单回调
```

每个 `local_callback()` 完成并 wake up 后，C 才继续下一项。React 只复制数据
并返回，不从回调中进入 C，因此没有嵌套 Asyncify。

以下路径禁止使用：

```text
C -> shim_update_inventory callback -> JS -> ccall(repopulate_perminvent)
```

`sys/libnh/libnhmain.c` 中现有 `displayInventory()` helper 和构建导出的
`_repopulate_perminvent` 不作为阶段五前端 API。是否在后续上游清理它们另行
处理，本阶段不扩大修改范围。

### 5.4 `#perminv` 非零参数

`doperminv()` 用 `win_update_inventory(1)` 请求窗口端口与永久背包交互。当前
shim 忽略参数并重填列表。prealpha-3 只承诺稳定展示和面板自身的键盘滚动，
不承诺 `#perminv` 命令转移浏览器焦点或执行分页。

本阶段保留“非零参数重填后返回”的安全行为，不增加另一个异步控制回调。该限制
写入 shim 接口文档；后续若要求 `#perminv` 聚焦侧栏，应使用 C 到 JS 的单向
focus 事件，仍不得由 JS 回调 C。

## 6. 配置协议

### 6.1 协议版本 2

现有协议版本 1 已定义 bits 0 至 24 和 28 至 30。阶段五使用：

```text
bit 25      perm_invent
bits 26-27  perminv_mode code
bits 28-30  protocol version = 2
bit 31      保留，必须为 0
```

mode code：

| code | 核心值 |
|-----:|--------|
| 0 | `none` |
| 1 | `all` |
| 2 | `full` |
| 3 | `in-use` |

解码继续拒绝未知位、错误版本和非法字段组合。WASM shim 与 TypeScript 必须在
同一次运行时重建中升级，不能让协议 1 前端配协议 2 WASM。

### 6.2 规范化

Settings 使用：

```ts
type PermanentInventoryMode = "all" | "full" | "in-use";

interface NetHackSettings {
  permInvent: boolean;
  perminvMode: PermanentInventoryMode;
}
```

UI 不暴露 `none`，因为关闭由 `permInvent` 表示。读取核心快照时：

- 核心 mode 为 `all`、`full` 或 `in-use` 时原样保留。
- 核心 mode 为 `none` 时规范化为 `permInvent=false`、`perminvMode="all"`。
- tty-only 或未知 mode 视为协议错误，不猜测。

生成 rc 的固定顺序是先 mode、后开关：

```text
OPTIONS=perminv_mode:<all|full|in-use>
OPTIONS=perm_invent
```

或：

```text
OPTIONS=perminv_mode:<all|full|in-use>
OPTIONS=!perm_invent
```

这样关闭时仍能保留玩家选择的 mode，而 mode 行不会把最终状态留在开启。

### 6.3 游戏内应用和回滚

`shim_apply_settings()` 按以下顺序处理新增字段：

1. 保存应用前的完整协议 2 快照。
2. 先通过 `parseoptions()` 应用 `perminv_mode`。
3. 再通过 `parseoptions()` 应用最终 `perm_invent` 布尔值。
4. 所有字段成功后比较实际快照。
5. `perm_invent` 或 mode 变化且最终为开启时，调用一次
   `update_inventory()`。
6. 失败时使用旧快照走同一解析路径回滚，再回报权威实际值。

关闭时不调用 `repopulate_perminvent()`；`shim_settings_result` 中的
`permInvent=false` 使 React 隐藏侧栏。原生 `O` 或 `#optionsfull` 修改在命令
结束后的下一次 `shim_settings_sync` 中同样被观察并持久化。

### 6.4 生效时间

| 字段 | Home Settings | 游戏内 Settings |
|------|---------------|-----------------|
| `permInvent` | 下一次 New Game 或 Continue 启动时 | 下一安全命令边界 |
| `perminvMode` | 下一次 New Game 或 Continue 启动时 | 下一安全命令边界 |
| 侧栏位置、折叠 | 下一次显示侧栏时使用 | Apply 后立即生效 |

`perm_invent` 和 `perminv_mode` 位于 `iflags`，不依赖存档中的 `flags` 恢复。
因此 Continue 也读取当前个人配置；恢复完成后的首次 `update_inventory()` 用
恢复后的实际物品重建侧栏。

## 7. profile schema 策略

### 7.1 扩展当前结构

当前内存和导出 profile 继续使用 schema 1，但重新定义为以下完整结构：

```ts
interface InterfaceSettingsV1 {
  terminalFontSize: "small" | "medium" | "large";
  messageHistoryLines: 3 | 5;
  followPlayer: boolean;
  permanentInventoryPosition: "right" | "below";
  permanentInventoryCollapsed: boolean;
}

interface NetHackSettingsV1 {
  // 既有字段保持不变
  permInvent: boolean;
  perminvMode: "all" | "full" | "in-use";
}
```

默认值：

```text
permanentInventoryPosition = right
permanentInventoryCollapsed = false
permInvent = false
perminvMode = all
```

桌面右侧背包使用单一 `64ch` 展开宽度，使常见物品描述尽量保持单行，同时让
地图在组合布局中自然偏左。空间不足时侧栏自动移到地图下方并使用最多 `80ch`
宽度；宽度不作为 profile 配置。

### 7.2 浏览器存储

```text
blisshack.profile.v1
```

继续使用现有 key，不增加 `blisshack.profile.v2`。扩展后的 schema 1 仍严格
要求完整字段：

- 缺少新增字段的旧开发记录按 invalid 处理，应用使用完整新默认值。
- 不从旧记录提取可解析字段，不形成混合配置。
- 玩家 Apply 或 Restore Defaults 后，以一次 `setItem()` 写入完整新结构。
- stale revision 继续比较同一 key 的原始文本，阶段四多页面保护不变。
- Clear Local Data 仍只需删除现有 profile key。

### 7.3 文件与备份

- 新 `.bhprofile` 继续标记 schema 1，但要求扩展后的完整字段。
- 缺少新字段的旧 `.bhprofile` 拒绝导入，不迁移。
- 完整备份容器继续为 schema 1，嵌入的 profile 必须符合扩展后的当前结构。
- 包含旧 profile 结构的 `.bhbackup` 拒绝导入，不恢复其中的存档。
- profile diff 和备份预览加入五个新字段。

这是 prealpha 阶段有意接受的破坏性格式更新。进入有真实玩家数据的 alpha
阶段前必须重新评审 schema 版本和迁移政策；届时不能继续原地重定义已发布
格式。

## 8. 永久背包前端模型

### 8.1 权威状态

当前 `WindowState` 是可变的菜单构建缓冲，`beginMenu()` 和 `addMenuItem()` 不
发布 snapshot。阶段五增加不可变的已提交永久背包状态：

```ts
interface PermanentInventoryState {
  revision: number;
  windowId: number;
  prompt: string;
  items: readonly MenuItem[];
}
```

只有处理永久菜单的 `select_menu(PICK_NONE)` 时，bridge 才复制 prompt 和完整
items、递增 revision 并一次发布。`begin_menu` 到 `end_menu` 之间的构建缓冲
不会直接交给 React。`GameSnapshot` 可以用该状态替代单独的
`inventoryWindowId`，或在过渡期间同时保留 ID；组件只读取不可变提交值。

面板只在以下条件同时满足时渲染：

```text
runtimeSettings.permInvent == true
permanentInventory != null
提交来源的 menuBehavior 包含 MENU_BEHAVE_PERMINV
```

关闭开关会立即隐藏面板，即使核心保留 `WIN_INVEN` 供后续重用。窗口销毁或
bridge reset 会清空活跃 ID；窗口销毁后最后一次已提交快照保留到当前 session
结束，bridge reset 再清空内容，防止下一局显示旧物品。

每次 `beginMenu()` 清空构建缓冲，`selectMenu()` 原子替换已提交快照。窗口
销毁按 `windowId` 清除活跃窗口引用，但不删除最后一次提交值。React 不在
`add_menu()` 过程中渲染半成品列表。revision 在每个 session 内单调递增，
bridge reset 后重新开始；它只表示“这是否仍是用户看到的同一份列表”，不是跨
session 的物品 ID。

### 8.2 数据映射

每行只使用现有 `MenuItem`：

- `glyph`：有 glyph 时显示其 `ttyChar` 和 NetHack color；无 glyph 时保留稳定
  占位宽度。
- `accelerator`：作为物品字符显示，例如 `a`、`b`。
- `text`：原样显示 NetHack 格式化后的名称、数量和装备说明。
- `attribute`、`color`：使用现有文本样式映射。
- `itemFlags & MENU_ITEMFLAGS_SELECTED`：仅在核心明确设置时显示 selected。
- `identifier == null`：显示为分组标题或空背包说明，不当作可操作物品。

`add_menu()` 没有单独的数量、装备槽或使用状态字段。数量和
`(weapon in hand)` 等状态已经包含在 NetHack 文本中。本阶段不从文本解析，
也不把 identifier 误当成数量。

对 `identifier != null` 的行，状态层保留原始 identifier 和 accelerator。
prealpha-3 的组件仍把这些行渲染为不可交互内容，但不能在复制快照时丢弃这些
字段，也不能用数组索引或文本生成替代 ID，为后续动作层保留来源信息。

### 8.3 与临时菜单隔离

完整背包更新使用 `WIN_INVEN + MENU_BEHAVE_PERMINV + PICK_NONE`。
普通 `i` 和物品选择使用缓存的普通 `NHW_MENU` 窗口及
`MENU_BEHAVE_STANDARD`，继续打开 modal。

即使普通菜单与永久背包同时存在：

- 普通菜单的 `beginMenu()` 不清空永久背包窗口。
- modal 关闭不改变 `inventoryWindowId`。
- 永久背包更新不替换 `snapshot.modal`。
- 两者按各自 window ID 读取独立 `WindowState`。

### 8.4 后续物品动作的扩展边界

未来拖出、点击或快捷操作不应直接修改永久背包状态。建议另建独立的
`InventoryActionIntent` 编排层：

```ts
interface InventoryActionIntent {
  action: "drop" | "wear" | "wield" | "eat";
  inventoryRevision: number;
  identifier: number;
}
```

以“拖出物品并丢弃”为例，未来流程应是：

```text
拖放结束
  -> 确认仍处于主命令等待状态
  -> 确认 permanent inventory revision 未变化
  -> 发送原生 drop 命令 d
  -> 等待核心产生预期的物品选择请求
  -> 确认原物品字符仍是该请求的合法选项
  -> 提交该物品字符
  -> 其余数量、方向或确认提示交回现有输入 UI
```

不能不等待核心状态就一次性向 key queue 塞入 `d+x`。物品字符可能因排序、
合并、掉落或 `fixinv` 设置变化而重新分配；revision 变化、提示类型不符或物品
字符不再合法时必须取消 intent。可执行动作始终由 NetHack 核心产生的命令流程
决定，前端不从物品名称猜测“可吃”“可穿戴”等能力。

阶段五不实现该 intent、拖放手势或动作菜单，只确保展示状态具备 revision 和
原始 identifier，使以后增加动作层时不必重写永久背包数据模型。

## 9. 桌面布局和交互

### 9.1 布局

新增 `PermanentInventoryPanel.tsx`，放入游戏内容布局，不使用 modal 或浮动
card。

- `right`：地图列在左，永久背包在右；面板不覆盖消息、地图、状态或输入。
- 当可用宽度不足以容纳 `80ch + 配置宽度 + gap` 时，CSS 自动把 right
  fallback 到地图下方。
- `below`：无论宽度如何都放在地图下方。
- 面板高度在右侧时与地图区域受同一稳定约束，内容独立滚动。
- 下方布局设置合理 `max-height`，不能把状态和当前输入推出 viewport。
- `permInvent=false` 时不渲染空壳、标题或折叠 rail。

### 9.2 折叠

展开面板具有标题 `Inventory`、物品数量和使用 lucide 图标的折叠按钮。
按钮提供 `aria-label` 和 tooltip。

- 右侧折叠为固定宽度的图标 rail，不显示可能溢出的旋转文字。
- 下方折叠为单行 header。
- 折叠不改变 NetHack 的 `perm_invent`，核心继续发送更新。
- 展开时直接显示最新窗口内容，不请求 C 重填。
- 游戏内 Apply 后折叠状态立即变化，并持久化为未来默认值。

### 9.3 键盘和可访问性

- 展开列表使用有名称的 `role="region"` 和 `tabIndex=0`，允许方向键、
  Page Up、Page Down、Home、End 和浏览器原生滚动。
- 行本身不是按钮，不进入逐项 Tab 顺序，也不暗示可以操作物品。
- 行保留稳定的组件边界和 data，不加入当前无效的 click/drag handler。
- 折叠/展开按钮可见焦点明确。
- 面板更新使用普通 React 内容更新，不使用会连续朗读每次物品变化的
  assertive live region。
- 打开普通菜单 modal 时背景和永久背包一起 inert，焦点仍由 modal 管理。

## 10. Settings 集成

Settings 按玩家任务而不是 profile 的存储结构组织。新增独立的 `Inventory`
区段，把以下字段放在同一个功能组中：

- `Automatic pickup` 和 `Pickup categories`。
- `Sort inventory`。
- `Permanent inventory` 主开关。
- `Contents`：`All except gold` / `Full including gold` /
  `Items in use` select。
- `Preferred position`：`Right` / `Below` segmented control。
- `Start collapsed`：toggle。

后三项作为永久背包开关的从属控件显示。开关关闭时保留其当前值但禁用控件；
重新开启后恢复原选择。字段的持久化所有权不随页面分组改变：
`permInvent` 和 `perminvMode` 仍属于 `nethack`，位置和折叠状态仍属于
`interface`。

`showExperience` 和 `showTime` 在 `Interface` 区段的 `Status display` 子组
显示，但继续作为 NetHack 配置持久化和同步。说明文字明确：

- Home：新游戏和继续存档在下次 session 启动时生效。
- 游戏内：下一安全命令边界生效。
- `in-use` 由 NetHack 判断，不由前端分析文本。

Apply、Cancel、Restore Defaults、Import、Export、stale draft 和游戏锁行为
全部复用阶段二至四现有路径。

## 11. 错误和边界行为

- capability 意外缺失：核心拒绝游戏内开启；shim result 返回失败，profile
  不报告完整成功。
- 协议版本或 mode 非法：拒绝整个动态更新，回报当前权威快照。
- 缺少新增字段的旧 profile 或损坏 profile：沿用 invalid 状态并使用默认值。
- profile 写入失败：保留旧 profile 和 Settings draft。
- 背包窗口不存在：面板不显示；下一次合法永久菜单更新可以恢复。
- 永久菜单收到非 `PICK_NONE`：视为 bridge/core 契约错误并进入现有 fatal，
  不把它当成可点击侧栏。
- 永久菜单回调中任一解码失败：沿用 callback fatal，不能保留看似最新的
  半份列表。
- 空背包：显示核心发送的说明行，不显示伪造物品。
- 300 项列表：固定面板尺寸并滚动，不扩大页面导致输入区域抖动。

## 12. 预计代码和文档范围

上游文件：

```text
win/shim/winshim.c
sys/unix/hints/include/cross-pre2.500（仅当导出列表确需调整；默认不改）
```

前端：

```text
frontend/src/game-state.ts
frontend/src/nethack-bridge.ts
frontend/src/settings/profile.ts
frontend/src/settings/profile-store.ts
frontend/src/settings/profile-diff.ts
frontend/src/settings/nethackrc.ts
frontend/src/settings/runtime-settings-protocol.ts
frontend/src/backup/backup-file.ts
frontend/src/screens/SettingsScreen.tsx
frontend/src/screens/GameScreen.tsx
frontend/src/screens/PermanentInventoryPanel.tsx
frontend/src/App.css
对应测试
```

运行时和文档：

```text
frontend/public/nethack.js
frontend/public/nethack.wasm
frontend/public/nethack-runtime.json
doc/BlissHack/shim-interface-reference.md
doc/BlissHack/upstream-modifications.md
doc/BlissHack/plans/prealpha-3.md
```

默认不修改 `src/invent.c`、`src/options.c`、`include/wintype.h` 或
`sys/libnh/libnhmain.c`。当前核心调用链足以支持完整菜单重填；只有测试证明
现有语义与本设计不符时，才回到评审而不是扩大 C 修改。

## 13. 测试设计

### 13.1 profile 和配置单元测试

- 扩展后的 schema 1 全字段严格校验。
- 缺少新增字段的旧本地记录回退完整默认值。
- 旧 `.bhprofile` 和内嵌旧 profile 的 `.bhbackup` 被拒绝。
- 未知字段和错误类型仍被拒绝，不进行部分读取。
- Clear Local Data 删除现有 profile key。
- 三种位置/宽度、折叠、开关和三种 mode 的 diff 与往返。
- rc 固定顺序为 mode 后开关，关闭时最终保持关闭。

### 13.2 协议和 bridge 测试

- 协议 2 编解码所有新增字段。
- 协议 1、保留位、非法 mode 和 tty-only mode 被拒绝。
- 永久 `PICK_NONE` 同步返回 0，不产生 modal 或 pending input。
- 同一永久窗口的第二次更新替换第一份列表。
- 每次完整提交递增 revision；构建中的菜单不改变已提交 revision。
- 普通 `PICK_NONE` 仍是可关闭 modal。
- 永久窗口和普通选择菜单同时存在时互不覆盖。
- 窗口 destroy 清除活跃 inventory ID 并保留最后快照；bridge reset 和下一
  session 清除两者。
- `permInvent=false` 时即使旧窗口仍存在也不渲染。
- item snapshot 保留 identifier 和 accelerator，不把数组索引当身份。

### 13.3 组件和布局测试

- glyph、物品字符、标题、文本和 core-selected flag 正确显示。
- 无 glyph 和长文本不改变列宽或覆盖相邻内容。
- right、below、三种宽度、自动 fallback 和折叠状态正确。
- 折叠后更新，重新展开显示最新列表。
- 面板列表可聚焦和滚动，折叠按钮名称、tooltip、焦点可见。
- 普通菜单 modal 打开时面板不接收键盘输入。
- 20、100 和 300 行不改变地图固定尺寸。

### 13.4 真实 WASM 测试

- Emscripten shim 通过游戏内设置成功开启 `perm_invent`，证明 capability。
- 开启产生唯一 `MENU_BEHAVE_PERMINV` 窗口和 `PICK_NONE` 序列。
- 更新顺序严格为 start、零到多个 add、end、select。
- 关闭后权威快照为 false，后续普通输入不产生永久菜单更新。
- `all`、`full`、`in-use` 都被核心接受并回报规范值。
- 协议非法 payload 不改变开关或 mode。
- 更新过程中没有 reentry mutex 错误、额外输入请求或额外回合。
- 原生 `libnethack.a` shim 的能力声明不因 Emscripten 修改而改变。

### 13.5 Chromium 浏览器测试

1. Home 开启永久背包并开始新游戏，侧栏出现且不覆盖地图。
2. 拾取、丢弃、穿戴、卸下和堆叠数量变化会替换列表。
3. 按 `i` 打开的普通背包是 modal，关闭后侧栏仍存在。
4. 游戏内 Settings 切换三种 mode，内容范围和核心回报一致。
5. 游戏内关闭后侧栏消失；重新开启只出现一个侧栏。
6. 保存退出并 Continue 后，侧栏按恢复后的物品重建。
7. 退出第一局再开始第二局，不显示第一局物品。
8. 折叠时发生物品更新，展开后显示最新内容。
9. 右侧空间不足时移到地图下方，消息、状态和输入无重叠。
10. 另一页面持有 session lease 时，Home Settings 仍遵守阶段四锁规则。

## 14. 分步实施计划

每一步保持构建通过并作为独立审核点。步骤二集中完成唯一一次 WASM 重建。

### 步骤一：扩展当前 profile schema

- 在 schema 1 增加五个新字段、默认值和严格校验。
- 保持现有 storage key，不增加迁移器或旧格式分支。
- 更新 profile 文件、完整备份、差异预览和锁内 stale revision。
- 扩展 rc 生成器，但暂不让未更新 WASM 的游戏内协议发送新增字段。

验收：

- 缺少新字段的旧开发数据明确回退默认值或拒绝导入。
- 新 profile 和完整备份往返得到相同配置。
- profile 写入继续经过游戏锁和同一 key 原子替换。

### 步骤二：shim 能力和协议 2

- 仅在 `__EMSCRIPTEN__` 下声明 `WC_PERM_INVENT`。
- 扩展 C/TypeScript 32-bit 协议和严格校验。
- 在命令边界应用 mode 与开关，验证成功、规范化和回滚。
- 补充真实 WASM 的 capability、菜单顺序、模式和重入测试。
- 更新 shim 接口参考和上游修改清单。
- 用固定工具链重新生成运行时三件套。

验收：

- 游戏内开启不再被 `can_set_perm_invent()` 拒绝。
- 三种 mode 与开关的核心快照一致。
- `MENU_BEHAVE_PERMINV + PICK_NONE` 不阻塞。
- 原生 shim 不虚假声明 Emscripten consumer 的能力。

### 步骤三：永久背包状态模型和组件

- 在永久 `select_menu(PICK_NONE)` 时提交带 revision 的不可变列表快照。
- 把运行时开关与已提交永久背包组合成可见性判断。
- 实现 `PermanentInventoryPanel` 和只读 item rows。
- 保持普通菜单渲染器不变。
- 保留 identifier 和 accelerator，但不实现动作 intent。
- 覆盖替换、空列表、关闭、destroy、reset 和并存测试。

验收：

- 每个 session 最多一个侧栏。
- 更新不产生 modal、pending input 或重复列表。
- 数量与装备说明保持核心原文，结构化字段不靠文本猜测。
- revision 能识别展示期间发生的背包替换，为未来取消过期动作提供依据。

### 步骤四：游戏布局和界面配置

- 接入 right/below、三种固定宽度、折叠和自动 fallback。
- 增加 Settings 控件和即时界面应用。
- 完成键盘滚动、焦点、tooltip、长文本和 300 行布局测试。

验收：

- 侧栏不覆盖消息、地图、状态、输入或 modal。
- 窄桌面布局自动下移且无水平页面溢出。
- 折叠不停止核心更新，展开无需重入 WASM。

### 步骤五：行为浏览器测试

- 增加启动、拾取、丢弃、装备、卸下、数量变化和 mode 流程。
- 增加普通背包并存、保存继续、跨 session 清理和折叠更新流程。
- 保留阶段四双页面和原有 29 条 Chromium 流程。

验收：

- 所有物品变化在下一次核心更新后反映到侧栏。
- 保存恢复和第二局没有陈旧物品。
- Settings 与原生命令双向同步。

### 步骤六：阶段五综合验收

执行并记录：

```bash
cd frontend
npm run build:wasm
npm run lint -- --deny-warnings
npm test
npm run build
npm run test:integration:wasm
npm run test:integration:browser
npm run test:long
git diff --check
```

另行人工检查：

- right、below、三种宽度和折叠。
- 普通菜单与永久背包并存。
- 键盘焦点、滚动和 modal inert。
- 至少一次拾取、丢弃、穿戴、卸下、保存和继续。

完成后更新 `prealpha-3.md` 的阶段五结果。实现改动保留供用户审核；用户确认后
提交阶段实现，再合并到 `BlissHack`。

## 15. 实施前需要用户确认

1. 阶段五从当前已完成阶段四的 `BlissHack` 基线开发，而不是回到阶段一旧提交。
2. `WC_PERM_INVENT` 只在 Emscripten shim 声明，原生 shim 能力不变。
3. 不实现完整 `ctrl_nhwindow()` 或 slot-based inventory。
4. `#perminv` 在 prealpha-3 只安全重填，不负责把焦点移入浏览器侧栏。
5. prealpha 阶段直接扩展 schema 1，不兼容或迁移旧开发 profile 与 backup。
6. 永久背包默认关闭，mode 默认 `all`。
7. 侧栏配置采用 right/below 和折叠布尔值；桌面右侧展开宽度统一为 64ch。
8. 数量及装备状态显示 NetHack 原文，不增加文本解析或新的物品查询 ABI。
9. 永久背包快照保留 revision、identifier 和 accelerator；本阶段不实现拖放、
   点击操作、`InventoryActionIntent` 或 `d+x` 自动输入。
10. C 修改默认只限 `win/shim/winshim.c`；若测试证明需要修改核心文件，先暂停
   并重新评审。
