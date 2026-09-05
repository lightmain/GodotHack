# prealpha-3 阶段二：Settings 和个人配置设计评审

## 1. 文档状态

本文是 prealpha-3 阶段二的设计评审和分步实施计划。用户于 2026-09-06
确认开始分步实施，并补充以下要求：

- 游戏处于主命令等待状态时，Esc 打开 BlissHack 暂停界面。
- 暂停界面提供 Resume、Settings、Save and Exit。
- 游戏内可以修改 BlissHack 界面配置。
- 受支持的 NetHack 配置应当能够在图形界面和原生命令之间双向同步。

实现仍按本文第 11 节逐步验收；不能因为开始实施而绕过其中的 shim、WASM 和
浏览器测试门禁。

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

## 4. 游戏内暂停、Settings 和同步

### 4.1 暂停界面

NetHack 是回合制程序。等待主命令时，核心已经通过 Asyncify 停在
`shim_nhgetch()` 或 `shim_nh_poskey()`，因此不需要新的暂停线程或计时器。
React 截获 Esc 且不完成当前输入 Promise，就能保持核心暂停。

暂停界面是 modal，包含：

- `Resume`：关闭 modal，继续等待原来的输入，不向 NetHack 发送字符。
- `Settings`：在同一暂停层进入 Settings，不创建 module，不调用 `main()`。
- `Save and Exit`：关闭暂停层并向原输入请求发送 ASCII `S`，完整复用
  NetHack 的确认、保存、退出和 IDBFS flush 流程。

不能仅根据“当前有 key/position input request”判断是否可以暂停。
`nh_poskey()` 也用于地图位置选择。NetHack 已用
`program_state.input_state == commandInp` 标记主命令输入；shim 需要把该状态
作为窄事件通知 React：

- `commandInp`：Esc 打开暂停界面，不发送给核心。
- `getposInp`、`getdirInp` 或 `otherInp`：Esc 保持 NetHack 原生取消行为。
- 已有 menu、text、line、yn 或 message 交互时：Esc 交给现有 modal。

### 4.2 为什么现有回调不足

NetHack 的 `preference_update()` 只通知窗口端口已经声明支持的 wincap 配置，
并且只传配置名，不传新值。它不能覆盖 `autopickup`、`safe_pet` 等普通游戏
配置，也不能可靠获知 `number_pad` 的准确模式。

React 也不能在 Asyncify 等待输入时额外 `ccall()` 进入 WASM。这样会重入尚未
返回的 C 调用栈，是项目明确禁止的路径。

因此双向同步需要在 `win/shim/winshim.c` 中增加一个限定为首版字段的协议，
而不是解析菜单文字或模拟一串 `O` 菜单按键。

### 4.3 建议的 shim 协议

协议只处理本文件列出的 NetHack 配置，不接受任意 rc 指令：

1. shim 在安全的主命令边界调用 `get_option_value()`，取得七个可在游戏内修改
   的选项规范值。
2. shim 把初始快照和后续变化通知 TypeScript。
3. 图形 Settings 提交修改时，TypeScript 只把经过类型校验并由生成器产生的
   选项更新放入待处理队列。
4. shim 在下一个安全主命令边界取得待处理更新，并在原有 C 调用栈内调用
   `parseoptions()`；不从 JavaScript 反向调用 C。
5. shim 再读取实际值并回传，React 以核心确认后的值更新界面。

如果 Settings 在核心已经等待主命令时提交，桥接层可以用一个 shim 私有控制值
唤醒本次等待；该控制值不能作为普通 NetHack 按键返回。shim 消费控制值、应用
配置后继续等待真实命令，因此不消耗游戏回合。

这项修改只应涉及 shim 和 TypeScript 桥接，不修改 `src/options.c` 的通用
选项语义。修改仍须遵守上游文件标记、shim 接口记录、原生测试和 WASM 三件套
同步更新要求。

### 4.4 双向同步规则

- 继续存档后收到的第一份核心快照只建立“当前游戏值”，不覆盖个人默认配置。
  否则打开一个旧存档会意外改写所有新游戏的默认值。
- 玩家此后通过 `O`、`#optionsfull`、`@` 等原生命令改变受支持字段时，下一份
  核心快照同时更新图形控件和个人默认配置。
- 玩家通过游戏内 Settings 修改时，先由核心应用并回报实际值，再把已确认值
  保存为个人默认配置。
- `tutorial` 不能在游戏中改变当前流程；游戏内 Settings 可以修改它，但只标记
  为“下次新游戏生效”。
- `#saveoptions` 写出的 `.nethackrc` 仍是当前 module 的临时派生文件。配置
  同步依赖核心实际值快照，不依赖读取或解析该文件。

问题 3 的含义是：需要同时区分当前游戏实际值、未来游戏默认值和运行时 rc。
本方案允许玩家的主动修改在当前游戏与未来默认值之间同步，但不会让恢复存档
时载入的旧值静默覆盖个人配置。

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

这与“所有布尔值都使用开关”的计划存在表达差异。首版开关命名为
“Offer tutorial for new games”：

- `true`：不生成 tutorial 行，保留 NetHack 原生询问。
- `false`：生成 `OPTIONS=!tutorial`，跳过询问和教程。

该方案保留当前默认体验，但不提供“每次强制进入教程”。三项选择
`ask / always / never` 留作未来扩展。

## 7. 生效时间

“下一局”需要按数据归属进一步区分：

| 配置 | 当前运行中的游戏 | 下一次新游戏 | 下一次继续存档 |
|------|------------------|--------------|----------------|
| 三项界面配置 | 游戏内 Apply 后立即生效 | 使用已保存值 | 使用已保存值 |
| `tutorial` | 只修改未来默认值 | 生效 | 不重新开始教程，实际无作用 |
| `number_pad` | 在安全命令边界生效 | 生效 | 启动时生效；它属于不写入存档的 `iflags` |
| 其余六项 NetHack 配置 | 在安全命令边界生效，并可随当前存档保存 | 生效 | 初始值来自存档，之后可在游戏内修改 |

`autopickup`、`pickup_types`、`safe_pet`、`sortpack`、`showexp` 和 `time`
都位于会写入存档的 `struct flag`。恢复流程先读取 rc，随后把保存的整个
`flags` 恢复进内存。因此仅在 Home 修改个人配置后继续旧存档，这六项最初仍
保持该存档上次保存时的值。进入游戏后，玩家可以在暂停界面的 Settings 或
NetHack 原生选项命令中修改它们。

Settings 必须在这六项旁显示“New games; existing saves keep their saved
value until changed in game”，不能笼统显示“Next game”。游戏内 Settings
显示核心回报的当前值；Home Settings 显示个人默认值。

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

### 8.2 游戏内 Apply 的边界

游戏内 Apply 还涉及当前 C 内存，浏览器存储与 NetHack 核心之间不存在共同
事务。流程为：

1. 校验完整 draft。
2. 由 shim 在安全命令边界应用可动态修改的 NetHack 字段。
3. 等待核心回报规范化后的实际值。
4. 把实际值和界面配置组成完整个人配置，执行一次 `setItem()`。
5. 持久化成功后发布界面配置并关闭 Settings。

如果核心拒绝设置，个人配置和界面配置都不提交。如果核心应用成功但
localStorage 随后失败，当前游戏值已经改变且不能假装回滚；界面必须明确提示
“当前游戏已改变，但未来默认值未保存”。这是跨 WASM 和浏览器存储边界无法
消除的部分成功，不得报告为完整成功。

### 8.3 Import 和 Restore Defaults

导入和恢复默认值复用同一个完整记录提交函数：

- 导入先完成全部校验和差异预览，再由玩家确认并一次提交。
- Restore Defaults 先确认，再提交完整默认记录。
- Home 中任一操作失败时不发布部分界面变化，也不改变 NetHack 配置。
- 游戏中导入和恢复默认值复用 8.2 的当前核心应用和结果报告规则。

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

## 11. 阶段二分步实施计划

每一步都必须保持应用可构建、相关测试通过并形成独立审核点。除步骤五外不修改
上游 NetHack 文件或重新生成 WASM。

### 步骤一：配置领域模型和持久化

实现与 UI 无关的配置基础：

- `InterfaceSettingsV1`、`NetHackSettingsV1` 和完整 profile 类型。
- 默认值、规范化、严格校验和不可变复制。
- `blisshack.profile.v1` 的读取与单次原子替换。
- localStorage 缺失、抛错、损坏和不支持 schema 的恢复结果。
- NetHack rc 确定性生成器。

验收：

- 全部字段、枚举、缺失字段和非法输入有单元测试。
- rc 输出顺序、布尔语法、pickup 符号和 `number_pad` 六种值有快照或精确断言。
- 本步不改现有页面和 session 生命周期。

### 步骤二：配置上下文和界面设置生效

在 React 顶层建立唯一 profile 状态，接通三项界面配置：

- 终端字号通过固定 class 切换。
- 消息区域显示 3 或 5 行。
- 地图在玩家位置变化后按配置决定是否跟随。
- 配置不可用 warning 进入可测试状态，不写入诊断日志敏感内容。

验收：

- 刷新后恢复配置。
- 修改一个字段不改变其他字段。
- 三种字号和两种消息高度在桌面宽度下不重叠。

### 步骤三：Home Settings 和个人配置文件

增加 Home 到独立 Settings screen 的状态和 UI：

- `Interface`、`NetHack`、`Profile` 三个区段。
- Apply、Cancel、Restore Defaults、Export Profile、Import Profile。
- 离开未保存表单时确认。
- 导入差异预览和确认。
- Home 与 Settings 往返时保留 prepared module。

验收：

- 打开、取消、Apply 和导入导出都不创建 module、不调用 `main()`。
- Apply 失败和导入失败不产生部分更新。
- `.bhprofile` 导出后可在默认状态重新导入并得到相同配置。
- 键盘焦点、标签和 modal 焦点恢复通过组件测试。

### 步骤四：启动时安装 `.nethackrc`

在 session 启动门禁接入运行时文件：

- `main()` 前将最新配置原子写入 `/home/web_user/.nethackrc`。
- Home Settings 修改后复用当前 prepared module。
- 写入失败时不调用 `main()`。
- 新游戏和继续存档分别验证第 7 节的生效规则。

验收：

- 真实 WASM 读取生成文件。
- `tutorial`、`number_pad` 和至少一个持久选项有端到端证明。
- 现有 New Game、Continue、保存和恢复测试无回归。

### 步骤五：一次性补全游戏内 shim 协议

集中完成所有需要重新构建 WASM 的工作：

- 从 `program_state.input_state` 向前端报告是否处于 `commandInp`。
- 增加限定字段的待应用配置通道，不接受任意 rc 文本。
- 在安全命令边界调用 `parseoptions()`。
- 用 `get_option_value()` 发布七项动态配置的规范快照和变化。
- 更新 shim 接口文档、上游修改清单及 C/WASM 测试。
- 使用固定工具链重新生成并一起提交
  `nethack.js`、`nethack.wasm` 和 `nethack-runtime.json`。

验收：

- Asyncify 等待期间没有外部 `ccall()` 和重入。
- 应用配置不消耗回合、不产生普通按键。
- `O`、`#optionsfull` 和 `@` 造成的受支持变化能被观察。
- 非法字段和值在进入 `parseoptions()` 前被拒绝。

### 步骤六：暂停界面和游戏内 Settings

在 Game screen 增加暂停状态和入口：

- 仅 `commandInp` 时由 Esc 打开暂停 modal。
- Resume 恢复同一个待处理输入。
- Settings 复用步骤三的表单组件，但显示当前核心实际值。
- Save and Exit 向原输入发送 `S`，复用原生确认和退出流程。
- 原生命令变化同步图形控件；玩家主动变化同步个人默认配置。

验收：

- Esc 在主命令处不进入核心；在方向、位置、菜单和确认提示中保持原生含义。
- 暂停、恢复和打开 Settings 都不创建新 session 或 module。
- Save and Exit 与键盘 `S` 产生相同确认、保存、flush 和返回 Home 流程。
- 恢复旧存档的初始快照不会覆盖个人默认值。
- 图形修改和原生命令修改双向同步。

### 步骤七：阶段二综合验收

执行并记录：

- 全部前端单元测试、lint 和生产构建。
- WASM 集成测试。
- Chromium Settings、暂停、同步、导入导出和保存退出流程。
- 键盘与焦点检查。
- `git diff --check`。

同时更新 `prealpha-3.md` 的阶段二结果；只有上述项目全部通过后才开始阶段三。

## 12. 已确认的设计决定

1. **配置来源**：采用单个 `localStorage` 记录
   `blisshack.profile.v1`；`.nethackrc` 每个 module 启动前生成，不新增配置
   IDBFS。
2. **游戏内入口**：主命令等待时 Esc 打开暂停界面，并从其中进入 Settings。
3. **游戏内同步**：玩家主动进行的图形修改和原生命令修改双向同步；恢复存档
   的初始值不自动覆盖个人默认配置。
4. **界面默认值**：`medium`、5 行消息、自动跟随玩家。
5. **教程语义**：保留布尔开关；true 表示新游戏时询问，false 表示跳过教程。
6. **已有存档语义**：六项 persistent 配置最初使用存档值，进入游戏后允许
   玩家修改；`number_pad` 每个 session 从个人配置读取。
7. **提交原子性**：个人配置以单 key 一次替换；当前 C 内存是独立运行时边界，
   跨边界部分失败必须准确报告。
8. **损坏恢复**：损坏记录整份回退默认值但不自动覆盖；持久化不可用时不静默
   声称保存成功。
9. **个人配置格式**：采用第 9 节完整 JSON 结构、1 MiB 上限和严格校验规则。
