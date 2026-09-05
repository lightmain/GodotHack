# prealpha-3 阶段二：Settings 和个人配置设计评审

## 1. 文档状态

本文是 prealpha-3 阶段二实现前的强制设计评审。当前状态为**等待用户确认**。
用户确认第 12 节之前，不实现配置持久化、Settings 页面或运行时
`.nethackrc` 写入。

本文中的结论来自当前仓库的 NetHack 5.0 源码、已提交 Emscripten 运行时和
prealpha-2 module 生命周期。它回答的不只是“配置项放在哪里”，还包括以下
容易混淆的问题：

- 浏览器配置、运行时配置文件和存档内配置分别由谁负责。
- 点击 Apply 成功究竟承诺哪些数据已经保存。
- “下一局生效”对于新游戏和继续旧存档是否含义相同。
- NetHack 原生默认行为能否由一个普通布尔开关无损表示。

## 2. 已确认的当前行为

### 2.1 `HOME` 和 `.nethackrc` 路径

Emscripten 运行时默认创建 `/home/web_user`，并向 C 环境提供：

```text
HOME=/home/web_user
```

`frontend/src/nethack-bridge.ts` 当前只清空 `USER` 和 `LOGNAME`，没有覆盖
`HOME`。NetHack 以 Unix 配置编译，`src/cfgfiles.c` 在没有命令行
`--nethackrc` 和 `NETHACKOPTIONS` 覆盖时查找：

```text
/home/web_user/.nethackrc
```

NetHack 在 `main()` 中、窗口系统初始化前调用 `initoptions()`，并在其中读取
该文件。因此运行时配置文件必须在调用 `main()` **之前**存在。

问题 1 的含义是：不能只知道桌面 NetHack 通常读取 `~/.nethackrc`，还必须
证明 WASM 中的 `~`、真实绝对路径和读取时机。当前答案分别是
`/home/web_user`、`/home/web_user/.nethackrc` 和每个 module 首次调用
`main()` 时。

### 2.2 当前持久文件系统边界

当前 game module 只把 `/save` 挂载为 IDBFS：

```text
/save  -> IndexedDB
```

`/home/web_user` 仍是 module 私有的 MEMFS。每个 module 都有全新的文件系统，
所以留在 `/home/web_user/.nethackrc` 的文件不会自动进入下一 module。

Home 持有一个已经创建、完成 `/save` populate、但尚未调用 `main()` 的
module。打开或取消 Settings 必须继续保留这个 module。

## 3. 配置所有权和存储方案

### 3.1 建议方案

个人配置的唯一持久化来源使用浏览器 `localStorage`，键名为：

```text
blisshack.profile.v1
```

该键中的一个 JSON 记录同时包含两个互相独立的字段：

```text
interface  -> React 界面配置
nethack    -> 受支持的 NetHack 配置
```

运行时 `.nethackrc` 不作为第二个持久化来源。它是在每个 game module 调用
`main()` 前，由已经校验的 `nethack` 配置确定性生成的派生产物：

```text
localStorage 中的版本化个人配置
                 |
                 +--> React 读取 interface
                 |
                 +--> 生成 /home/web_user/.nethackrc
                                      |
                                      +--> NetHack initoptions()
```

不把运行时配置文件放进现有 `/save` IDBFS，原因是：

1. `/save` 的职责是保存 NetHack 正式存档，不应混入应用配置。
2. 配置已经由 `localStorage` 持久化，再同步一份文件会产生两个事实来源。
3. IDBFS populate 可能把旧 `.nethackrc` 覆盖到新 module，增加顺序风险。
4. 完整备份和清除数据需要处理结构化个人配置，而不是解释任意 rc 文本。

也不新增独立 HOME IDBFS。独立挂载会增加第二套异步初始化、同步和失败状态，
却没有提供结构化记录之外的新能力。

问题 2 的含义是：需要选择配置的权威数据源，而不只是选择一个目录。建议答案
是“每个 game module 启动前由持久化配置生成”。

### 3.2 写入运行时文件的时机

每个 module 完成创建后可以写入 MEMFS，但必须在 `main()` 前再次从当前内存
配置生成文件。这样能够覆盖以下流程：

```text
进入 Home -> module 已准备好 -> 打开 Settings -> Apply -> 开始游戏
```

Apply 不创建新 module。开始游戏的同一个 module 会收到最新生成的
`.nethackrc`。

写文件使用 UTF-8、LF 换行和结尾换行。先写同目录临时文件，再 rename 到
`.nethackrc`；写入或 rename 失败时不调用 `main()`。配置生成顺序固定为：

```text
tutorial
autopickup
pickup_types
number_pad
safe_pet
sortpack
showexp
time
```

除本文件定义的行外不生成注释、任意指令或用户文本。

## 4. 游戏内配置变化

NetHack 的 `O`/`#optionsfull` 可以在游戏内修改允许动态修改的选项，
`#saveoptions` 还可以覆盖当前运行时 `.nethackrc`。这些变化**不同步回**
BlissHack 个人配置，原因如下：

1. 当前 shim 没有可靠事件通知 React 哪个选项在何时变化。
2. 从 C 内存或任意 rc 文本反向解析会建立计划明确排除的通用配置解析器。
3. 同步回个人配置会让同一字段同时由 Settings 和游戏内菜单写入。
4. 当前 `.nethackrc` 是 module 私有派生文件；下一 module 会重新生成它。

因此，游戏内变化遵循 NetHack 自己的存档规则：

- 写入 `struct flag` 的持久选项会随当前游戏存档保存和恢复。
- `number_pad` 位于非持久的 `iflags`，下次 module 仍从个人配置读取。
- `#saveoptions` 写出的文件只影响当前 module，不能改变个人配置。
- Settings 只在没有活动 session 时可用，不从外部修改运行中的游戏。

问题 3 的含义是：要决定 NetHack 内部修改是否成为新的配置权威来源。建议答案
是“不需要，也不允许自动同步回浏览器个人配置”。

## 5. 首版界面配置

建议默认值为：

```ts
interface InterfaceSettingsV1 {
  terminalFontSize: "small" | "medium" | "large";
  messageLineCount: 3 | 5;
  followPlayer: boolean;
}

const defaults = {
  terminalFontSize: "medium",
  messageLineCount: 5,
  followPlayer: true,
};
```

- `terminalFontSize`：Apply 或成功导入后立即改变终端区域字号。
- `messageLineCount`：立即改变 React 可见消息行数，不删除 NetHack 消息历史。
- `followPlayer`：立即改变后续玩家位置更新时的滚动行为。

编辑表单使用独立 draft。修改控件不会直接改变已应用配置；只有 Apply 成功后
才整体发布 draft。Cancel 丢弃 draft。

## 6. 首版 NetHack 配置契约

### 6.1 布尔语法

NetHack 布尔配置的规范输出为：

```text
OPTIONS=<name>
OPTIONS=!<name>
```

解析器还接受 `no<name>` 和部分带值写法，但生成器不使用别名或宽松语法。

### 6.2 配置明细

| 配置 | 原生默认 | Settings 允许值 | 生成语法 | 实际作用 |
|------|----------|-----------------|----------|----------|
| `tutorial` | on，但未显式配置时询问 | 见 6.3 | 省略或 `OPTIONS=!tutorial` | 新游戏开始前是否提供教程选择 |
| `autopickup` | off | `boolean` | `OPTIONS=autopickup` / `OPTIONS=!autopickup` | 走到物品上时是否尝试自动拾取 |
| `pickup_types` | all | `all` 或非空类别集合 | `OPTIONS=pickup_types:all` 或符号串 | 限制 autopickup 处理的物品类别 |
| `number_pad` | `0` | `-1, 0, 1, 2, 3, 4` | `OPTIONS=number_pad:<n>` | 选择字母、数字键盘和兼容布局 |
| `safe_pet` | on | `boolean` | 正向或 `!` 语法 | 防止玩家明知目标是宠物仍攻击它 |
| `sortpack` | on | `boolean` | 正向或 `!` 语法 | 背包显示时按物品类型分组 |
| `showexp` | off | `boolean` | 正向或 `!` 语法 | 在状态区域显示累计经验值 |
| `time` | off | `boolean` | 正向或 `!` 语法 | 在状态区域显示经过的游戏回合数 |

`number_pad` 各值的准确含义：

| 值 | 含义 |
|---:|------|
| `0` | 使用 `yuhjklbn` 字母移动 |
| `1` | 使用数字移动，`5` 是 `G` 移动前缀 |
| `2` | 使用数字移动，`5` 是 `g` 前缀；保留旧 PC Hack/MS-DOS 兼容键 |
| `3` | 使用电话式数字布局，即 `123` 在上、`789` 在下 |
| `4` | 电话式布局加 PC Hack/MS-DOS 兼容行为 |
| `-1` | 使用字母移动，但交换 `y` 与 `z` 的相关用途，适配 QWERTZ 键盘 |

`pickup_types` 使用稳定类别 ID 保存，在生成 rc 时才映射成 NetHack 符号：

| ID | 符号 | 类别 |
|----|------|------|
| `weapons` | `)` | 武器 |
| `armor` | `[` | 护甲 |
| `rings` | `=` | 戒指 |
| `amulets` | `"` | 护符 |
| `tools` | `(` | 工具 |
| `food` | `%` | 食物 |
| `potions` | `!` | 药水 |
| `scrolls` | `?` | 卷轴 |
| `spellbooks` | `+` | 法术书 |
| `wands` | `/` | 魔杖 |
| `coins` | `$` | 金币 |
| `gems` | `*` | 宝石和小石块 |
| `rocks` | `` ` `` | 巨石和雕像 |
| `ironBalls` | `0` | 铁球 |
| `chains` | `_` | 锁链 |
| `venoms` | `.` | 毒液 |

不提供“空集合”。NetHack 把空值重新解释为 all；如确实需要近似“什么都不捡”，
原生建议只选择正常游戏中不会遇到的 `venoms`。类别数组最多 16 项，不允许
重复项，生成符号时始终按上表顺序排列。

问题 4 的含义是：Settings 的控件值必须能无歧义地映射到当前 NetHack 5.0
解析器，而不是根据旧版文档猜测。上表同时定义了表单校验、JSON 校验和 rc
生成器的共同契约。

### 6.3 `tutorial` 不是普通二态选项

NetHack 5.0 的实际行为有三种：

1. rc 中没有 `tutorial`：默认值为 on，但开始新游戏时询问是否进入教程。
2. rc 中有 `OPTIONS=tutorial`：不询问，直接进入教程。
3. rc 中有 `OPTIONS=!tutorial`：不询问，直接进入普通游戏。

这与“所有布尔值都使用开关”的计划存在表达差异。建议首版开关命名为
“Offer tutorial for new games”：

- `true`：不生成 tutorial 行，保留 NetHack 原生询问。
- `false`：生成 `OPTIONS=!tutorial`，跳过询问和教程。

该方案保留当前默认体验，但不提供“每次强制进入教程”。另一种方案是三项选择
`ask / always / never`，它更完整，但不再是布尔开关。此项需要用户确认。

## 7. 生效时间

“下一局”需要按数据归属进一步区分：

| 配置 | 当前运行中的游戏 | 下一次新游戏 | 下一次继续存档 |
|------|------------------|--------------|----------------|
| 三项界面配置 | Settings 不可进入 | Apply 后立即用于 Home；游戏 UI 继续使用 | 同左 |
| `tutorial` | 不修改 | 生效 | 不重新开始教程，实际无作用 |
| `number_pad` | 不修改 | 生效 | 生效；它属于不写入存档的 `iflags` |
| 其余六项 NetHack 配置 | 不修改 | 生效 | 存档中的旧值覆盖 rc 新值 |

`autopickup`、`pickup_types`、`safe_pet`、`sortpack`、`showexp` 和 `time`
都位于会写入存档的 `struct flag`。恢复流程先读取 rc，随后把保存的整个
`flags` 恢复进内存。因此玩家修改个人配置后继续旧存档，这六项仍保持该存档
上次保存时的值；修改只保证影响新游戏。

Settings 必须在这六项旁显示“New games; existing saves keep their saved
value”，不能笼统显示“Next game”。`number_pad` 显示“Next game session，
including continued saves”。

问题 7 的含义是：生效时机不仅取决于何时写 `.nethackrc`，还取决于 NetHack
恢复存档之后是否覆盖该字段。

## 8. Apply 的原子性

### 8.1 一个记录，一次提交

界面配置和 NetHack 配置以同一个版本化 JSON 记录写入一个 localStorage key。
Apply 按以下顺序执行：

1. 校验完整 draft。
2. 规范化数组顺序并生成完整候选记录。
3. 序列化候选记录，确认字节长度上限。
4. 调用一次 `localStorage.setItem()`。
5. 只有 `setItem()` 成功后，才把候选记录发布为当前 React 配置。
6. 成功后返回 Home；运行时 rc 仍在开始游戏前由当前配置生成。

`setItem()` 是对单个 key 的同步替换，不会只写 `interface` 或只写
`nethack`。任何校验、序列化或存储异常都保持旧内存值和旧持久值，Settings
保留 draft 并显示错误。

运行时 `.nethackrc` 是派生产物，不属于 Apply 的持久事务。开始游戏前若生成
或写入失败，则不调用 `main()`，个人配置本身仍然有效，用户可以恢复默认值
后重试。

问题 5 的含义是：如果两组配置分两次写入，第二次失败会产生用户无法判断的
混合状态。建议使用一个记录和一次替换，把原子边界放在个人配置上。

### 8.2 Import 和 Restore Defaults

导入和恢复默认值复用同一个完整记录提交函数：

- 导入先完成全部校验和差异预览，再由玩家确认并一次提交。
- Restore Defaults 先确认，再提交完整默认记录。
- 任一操作失败时不发布部分界面变化，也不改变 NetHack 配置。

## 9. 持久记录与个人配置文件

### 9.1 浏览器持久记录

localStorage 中保存：

```json
{
  "schemaVersion": 1,
  "interface": {
    "terminalFontSize": "medium",
    "messageLineCount": 5,
    "followPlayer": true
  },
  "nethack": {
    "tutorial": true,
    "autopickup": false,
    "pickupTypes": {
      "mode": "all",
      "types": []
    },
    "numberPad": 0,
    "safePet": true,
    "sortPack": true,
    "showExperience": false,
    "showTime": false
  }
}
```

字段名使用 TypeScript/JSON 风格，只有 rc 生成器知道 NetHack 名称和符号。
`pickupTypes.mode` 为 `all` 时 `types` 必须为空；为 `selected` 时必须包含
1 至 16 个合法、互不重复的 ID。

### 9.2 导出文件

个人配置文件使用 UTF-8 JSON、`.bhprofile` 扩展名和
`application/json` MIME type。完整结构为：

```json
{
  "format": "blisshack-profile",
  "schemaVersion": 1,
  "productVersion": "prealpha-3",
  "exportedAt": "2026-09-05T00:00:00.000Z",
  "interface": {
    "terminalFontSize": "medium",
    "messageLineCount": 5,
    "followPlayer": true
  },
  "nethack": {
    "tutorial": true,
    "autopickup": false,
    "pickupTypes": {
      "mode": "all",
      "types": []
    },
    "numberPad": 0,
    "safePet": true,
    "sortPack": true,
    "showExperience": false,
    "showTime": false
  }
}
```

`productVersion` 只说明导出来源，不参与兼容判断。兼容性只由
`format + schemaVersion` 决定。

### 9.3 大小和字段限制

- 在读取文本前检查文件 `Blob.size <= 1 MiB`。
- 解码必须是有效 UTF-8，顶层必须是普通 JSON object。
- `format` 必须精确等于 `blisshack-profile`。
- `schemaVersion` 必须是整数 `1`。
- `productVersion` 为最多 64 个 ASCII 可打印字符。
- `exportedAt` 为最多 64 字符、可被严格解释为 ISO-8601 的字符串。
- 已知枚举和数字只接受本文件列出的值，不做字符串到数字的宽松转换。
- `pickupTypes.types` 最多 16 项，每项最多 32 字符。
- 不递归保存或复制未知字段。

### 9.4 导入和未来兼容

- 缺失的已知设置字段使用当前 schema 的默认值。
- 已知字段存在但类型或值错误时，拒绝整个文件。
- schema 1 中的未知字段忽略，导入后不保留。
- 不支持的 `schemaVersion` 拒绝，不尝试猜测或降级。
- 将来若增加 schema 2，必须新增显式迁移器；不能改变 schema 1 的解释。
- 导入预览只列出实际变化的已知字段。
- 玩家确认前不写 localStorage、不改变当前配置、不写 `.nethackrc`。

问题 6 的含义是：导入文件是长期外部契约和不可信输入，必须明确字段、限制、
缺省和升级规则，而不能直接把 `JSON.parse()` 的结果放进应用状态。

## 10. 错误恢复

### 10.1 浏览器记录损坏

如果 localStorage 值不是合法 JSON、版本不受支持或已知字段非法：

1. 本页使用完整默认配置。
2. 显示一次可恢复 warning，说明已忽略损坏的本地配置。
3. 不自动覆盖原始值，便于刷新后问题仍可诊断。
4. 玩家 Apply 或确认 Restore Defaults 后，用合法完整记录替换它。

不从“能解析的部分字段”拼出混合配置，因为这会掩盖损坏。

### 10.2 localStorage 不可用

读取 localStorage 抛错或 API 不可访问时：

- 应用使用默认配置，Settings 仍可打开。
- 显示配置无法持久化的 warning。
- Apply、导入和恢复默认值尝试提交；失败时保持应用前的完整配置和 draft。
- Export Profile 仍可导出当前内存中的默认配置。

建议不提供静默的“仅本页生效”模式，以免玩家误以为配置已经保存。

### 10.3 运行时配置文件失败

rc 由封闭类型生成，正常情况下不存在用户可制造的语法错误。实现仍需：

- 在单元测试中逐项验证固定输出。
- 用真实 WASM 测试确认生成文件被当前 NetHack 5.0 接受。
- 写文件失败时不调用 `main()`，报告可恢复错误。
- 如果 NetHack 仍报告生成文件解析错误，把它视为实现缺陷并终止该 module，
  不覆盖个人配置，也不悄悄改用部分默认值启动游戏。

问题 8 的含义是：损坏来源不同，恢复策略也不同。外部持久数据可以安全退回
完整默认值；由本程序生成却被核心拒绝的 rc 不能静默忽略，否则玩家不知道
实际运行配置。

## 11. 实现边界和验证

确认设计后，阶段二建议拆成以下职责：

```text
profile schema/validator
  -> 默认值、规范化、导入导出结构

profile store
  -> 单 localStorage key 的读取和原子替换

NetHack rc generator
  -> 类型化 nethack 配置到固定文本

settings draft/controller
  -> Apply、Cancel、Restore、Import、Export

app state
  -> Home 与 Settings 导航，保留 prepared module

session start gate
  -> main() 前把最新 rc 写入当前 module
```

至少验证：

- 默认、缺失字段、损坏记录和 localStorage 抛错。
- 每个枚举、每种 `number_pad` 模式和全部 pickup 类别。
- rc 行顺序、UTF-8/LF、无未知指令。
- Apply、Import 和 Restore 的失败不产生部分更新。
- 打开、取消和应用 Settings 都不创建 module 或调用 `main()`。
- Settings 后启动新游戏读取新 rc。
- 继续存档时验证六项 persistent 配置保留存档值、`number_pad` 读取新值。
- `tutorial=true` 保留询问、`tutorial=false` 跳过询问。

## 12. 请求用户确认

请确认或修改以下决定；全部确认后才能开始阶段二实现：

1. **配置来源**：采用单个 `localStorage` 记录
   `blisshack.profile.v1`，`.nethackrc` 每个 module 启动前生成，不新增配置
   IDBFS。
2. **游戏内修改**：`O` 和 `#saveoptions` 的变化不反向同步到个人配置。
3. **界面默认值**：`medium`、5 行消息、自动跟随玩家。
4. **教程语义（建议）**：保留布尔开关；true 表示新游戏时询问，false 表示
   跳过教程。Settings 不提供“总是直接进入教程”。
5. **已有存档语义**：明确告知玩家六项 persistent 配置只影响新游戏；
   Settings 不修改或重写已有存档。
6. **提交原子性**：个人配置以单 key 一次替换；运行时 rc 是开始游戏前生成的
   派生产物，不纳入 localStorage 提交事务。
7. **损坏恢复**：损坏记录整份回退默认值但暂不自动覆盖；持久化不可用时不提供
   静默的仅本页 Apply。
8. **个人配置格式**：采用第 9 节完整 JSON 结构、1 MiB 上限和严格校验规则。

