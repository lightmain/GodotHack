# prealpha-3 阶段三：本地数据备份和存档救援设计评审

## 1. 文档状态

本文是 prealpha-3 阶段三的设计评审和分步实施计划，当前状态为**等待用户
确认**。确认前不实现完整备份、持久存储申请或清除本地数据。

本文以已经完成的阶段二实现为基线。阶段三不修改 NetHack raw save 格式，
不增加新的 game module 生命周期，也不修改 C、shim 或 WebAssembly 产物。

本阶段需要确认的核心决定是：

1. 正式存档无论是否兼容或能否解析身份，都允许原字节导出。
2. 完整备份使用本文第 5 节定义的 JSON 结构。
3. 导入先完整预检，再逐个处理存档，最后单独确认是否应用个人配置。
4. 不兼容存档在当前构建中记为跳过，不写入 `/save`；损坏或校验失败的条目
   记为失败。
5. 同名覆盖由玩家逐项选择，每个存档复用已有单文件事务和回滚语义。
6. 清除本地数据只删除 BlissHack 管理的 IDBFS 内容和两个已知
   `localStorage` 键，不调用 `localStorage.clear()` 或删除整个来源数据库。

## 2. 已确认的当前实现

### 2.1 存储和 module 生命周期

当前每次进入 Home 前创建一个 game module，并把 `/save` 挂载为 IDBFS。
该 module 完成 `syncfs(true)` 和存档枚举后停留在 Home；New Game 或
Continue 认领同一个 module 并最多调用一次 `main()`。

`frontend/src/storage/storage-service.ts` 已经提供：

```text
initialize()
listSaves()
readSave()
restoreOriginalSave()
deleteSave()
exportSave()
importSave()
flush()
```

同一个 storage service 的 `syncfs` 已串行执行。session manager 还用一个
Home operation 门禁阻止导入、导出、删除和 session 启动同时操作当前 module。

### 2.2 已有 raw save 能力

prealpha-2 已经实现：

- 对当前构建 fingerprint 和 49-byte 身份块的只读校验。
- 兼容存档的 `.nhsave` 原字节导入和导出。
- 同名覆盖预览。
- 临时文件、写后读校验、rename、flush 和失败回滚。
- 删除前保存原字节，并在 flush 失败时写回。

当前 `SaveValidation` 只有 `ready` 和带错误文本的 `invalid`。当前 UI 只允许
`ready` 存档导出。阶段三必须先把无效状态改成结构化分类，不能依靠比较英文
错误文本判断存档是“不兼容”还是“损坏”。

### 2.3 个人配置和诊断日志

个人配置的唯一持久来源是：

```text
localStorage["blisshack.profile.v1"]
```

诊断日志的持久来源是：

```text
localStorage["blisshack.diagnostics.v1"]
```

完整备份只包含经过 `validateProfile()` 规范化的个人配置，不包含诊断日志。
备份中的 profile 使用内部 `BlissHackProfileV1` 结构，不嵌套 `.bhprofile`
文件的 `productVersion` 和 `exportedAt` 外层元数据。备份本身已经有这两个
字段。

### 2.4 不建立新的事实来源

- `/save` 中的原始文件继续是正式存档的唯一事实来源。
- 完整备份是玩家主动下载的快照，不是浏览器内第二份自动副本。
- SHA-256 只验证备份条目在编码、保存和导入期间是否被改写，不表示该存档
  与当前或未来构建兼容。
- 浏览器持久存储授权只影响浏览器在磁盘压力下的自动清理策略，不是云备份。

## 3. 正式存档和状态分类

### 3.1 正式存档边界

阶段三继续只枚举 `/save` 的直接子项。一个条目只有同时满足以下条件才是
“正式存档”：

- 是普通文件，不是目录或符号链接。
- 文件名符合当前 WASM Unix save 命名：`0` 加 1 至 31 bytes 的 UTF-8
  角色名字。
- basename 不含 `/`、`\`、NUL、控制字符、空格、`.` 或 `..`。
- 不是以 `0.` 开头的内部文件。
- 不带 `.tmp`、`.bak`、`.e` 或 `~` 临时后缀。

这个判断只决定条目是否属于可展示、可救援和可备份的正式存档，不说明 bytes
有效。临时导入文件、运行期文件和其他 `/save` 内容不进入完整备份。

本地枚举、raw save 操作、备份导出和备份导入共用同一个 predicate，保证本
版本生成的备份不会因文件名规则差异而被本版本拒绝。导入代码只接受
`fileName`，自行拼接 `/save/${fileName}`；不接受备份中的绝对路径。

### 3.2 三种校验状态

`SaveValidation` 改为以下判别联合：

```ts
type SaveValidation =
  | { status: "ready"; identity: SaveIdentity }
  | { status: "incompatible"; reason: "fingerprint-mismatch" }
  | {
      status: "damaged";
      reason:
        | "not-binary"
        | "truncated"
        | "invalid-identity-size"
        | "invalid-player-name"
        | "invalid-character-identity"
        | "identity-file-name-mismatch"
        | "validation-failed";
    };
```

- `ready`：当前 fingerprint 和身份块均可解析；Continue 可用。
- `incompatible`：文件具备足够 header 字节，但 fingerprint 与当前构建
  不同；Continue 禁用。
- `damaged`：header 截断、身份块非法、文件名与身份不符或读取失败；
  Continue 禁用。

`shim_graphics_get_save_fingerprint()` 自身不可用属于当前 module 的实现或
运行错误，不把全部存档误报为损坏。

### 3.3 列表和救援导出

所有三种状态都显示在存档列表中，并都提供 Export 和 Delete：

- `ready` 显示角色名和四项身份。
- `incompatible` 显示 `Incompatible with this build`。
- `damaged` 显示 `Damaged or unrecognized save`。

导出始终逐字节读取原文件，不修补 header，不修改文件名，不写回 IDBFS。
能够解析身份时仍使用 `<角色名>.nhsave`；否则使用：

```text
blisshack-save-<SHA-256 前 12 个十六进制字符>.nhsave
```

该替代名称只由文件 bytes 决定，不包含虚拟路径，且同一文件重复导出得到相同
名称。文件读取或摘要计算失败时不开始下载。

## 4. 完整备份范围

完整备份包含：

- 当前已应用且通过校验的个人配置。
- `/save` 中全部正式存档的原始 bytes，包括 `ready`、`incompatible` 和
  `damaged`。
- 产品版本、构建编号和导出时间。

完整备份不包含：

- 诊断日志。
- 浏览器 user agent、URL、IndexedDB 数据库名或内部 object store 记录。
- `.nethackrc` 派生文件。
- 临时导入文件、运行期 level/checkpoint 文件或其他非正式 `/save` 条目。
- 当前运行中的未保存游戏状态。

如果没有正式存档，仍可以导出只含个人配置和空 `saves` 数组的备份。
如果持久存储初始化失败，不能证明 `/save` 的完整内容，`Export Full Backup`
失败；玩家仍可使用独立的 `Export Profile`。

## 5. 完整备份文件格式

### 5.1 外层结构

文件使用 UTF-8 JSON、`.bhbackup` 扩展名和 `application/json` MIME type。
schema 1 的完整结构为：

```json
{
  "format": "blisshack-backup",
  "schemaVersion": 1,
  "productVersion": "prealpha-3",
  "buildId": "full Git commit or development build ID",
  "exportedAt": "2026-09-06T12:00:00.000Z",
  "profile": {
    "schemaVersion": 1,
    "interface": {},
    "nethack": {}
  },
  "saves": [
    {
      "fileName": "0Ada",
      "byteLength": 12345,
      "sha256": "64 lowercase hexadecimal characters",
      "data": "canonical Base64 without whitespace"
    }
  ]
}
```

字段含义：

- `format` 必须精确为 `blisshack-backup`，用于与 `.bhprofile` 和
  `.nhsave` 区分。
- `schemaVersion` 决定整个备份容器的解释规则。
- `productVersion` 和 `buildId` 只描述来源，不决定兼容性。
- `profile` 必须通过当前 profile schema 的独立校验器。
- `fileName` 是 `/save` 下的 basename，不带 `/save/`。
- `byteLength` 是 Base64 解码后的字节长度。
- `sha256` 是对解码后全部 bytes 计算的小写十六进制摘要。
- `data` 是 RFC 4648 标准 Base64，使用 `+`、`/` 和必要的 `=` padding，
  不允许 URL-safe 字母表或空白。

导出文件名为：

```text
blisshack-backup-YYYY-MM-DDTHH-mm-ssZ.bhbackup
```

### 5.2 确定性和顺序

- `saves` 按 `fileName` 的 Unicode code point 顺序排列。
- JSON 使用两个空格缩进、LF 换行和结尾换行。
- SHA-256 使用浏览器 Web Crypto `crypto.subtle.digest()`。
- Base64 编解码按固定大小分块处理，不把数十 MiB 数组展开为函数参数。

相同 bytes 的摘要和 Base64 必须稳定。`exportedAt` 不同意味着整个 JSON
文本不要求逐字节相同。

### 5.3 大小限制

导入和导出都遵守相同上限，确保本版本导出的文件能够被本版本重新导入：

- JSON 文件最多 96 MiB。
- 最多 100 个存档。
- 每个解码后存档最多 64 MiB，且不能为空。
- 全部解码后存档合计最多 64 MiB。
- `productVersion` 最多 64 个 ASCII 可打印字符。
- `buildId` 最多 128 个 ASCII 可打印字符。
- `exportedAt` 必须是规范 UTC ISO-8601 时间。
- `fileName` 还受第 3.1 节限制。
- `sha256` 必须是 64 个小写十六进制字符。

导出时如果现有数据超过任一上限，停止导出并说明不能生成可恢复的完整备份，
不能静默漏掉文件。

## 6. 不可信输入校验

完整备份导入分为“容器预检”和“当前构建分类”。容器预检全部成功前不显示
确认、不写文件、不改 profile。

### 6.1 容器预检顺序

1. 在调用 `arrayBuffer()` 前检查 `File.size <= 96 MiB`。
2. 使用 fatal UTF-8 解码；拒绝 BOM、NUL 和非法 UTF-8。
3. 解析 JSON，并要求顶层、profile、save entry 都是普通 object。
4. 校验 `format`、schema、来源元数据和 profile。
5. 校验 `saves` 是长度不超过 100 的数组。
6. 校验每个 `fileName`、`byteLength`、`sha256` 和 Base64 文本。
7. 在解码前根据 Base64 长度检查声明长度、单文件限制和累计限制。
8. 逐项解码，要求重新编码结果与输入完全相同。
9. 要求实际长度等于 `byteLength`。
10. 计算 SHA-256，并使用完整摘要比较。
11. 拒绝重复 `fileName`。
12. 用当前构建校验器分类每个存档；对可解析身份的条目拒绝重复角色身份。

schema 1 的备份外层和 save entry 未知字段忽略，但不会进入规范化对象或再次
导出。嵌入的 `profile` 继续服从阶段二 `validateProfile()` 的严格字段规则。
任何已知字段缺失、类型错误或非法时拒绝整个备份。`schemaVersion` 不受支持
时拒绝，不猜测旧版或新版字段。

路径穿越、重复路径、重复角色、错误摘要或任一结构错误都使整个文件在写入前
失败。它们不是逐文件导入失败。

### 6.2 当前构建分类

通过容器预检后，每个条目标记为：

- `importable`：当前构建校验为 `ready`，且内部身份对应
  `fileName === "0" + playerName`。
- `incompatible`：fingerprint 不匹配；本次固定为跳过。
- `damaged`：当前构建无法识别，或兼容 header 下的身份与文件名不符；
  本次固定为失败。
- `conflict`：`importable` 的目标正式路径已经存在。

不兼容存档不能写入当前 IDBFS。这样不会让 Home 出现当前构建不能使用的新
文件，也不会把完整备份误解成跨版本迁移工具。原 bytes 仍保留在玩家选择的
`.bhbackup` 中，可由兼容构建再次尝试。

## 7. 完整备份导出

完整备份只从 Home Settings 提供。游戏内暂停 Settings 不显示数据管理区。

导出通过当前 prepared module 和 Home operation 门禁执行：

1. 确认没有活动 session，storage 已成功初始化。
2. 等待更早的 storage operation 完成。
3. 重新枚举全部正式存档，不使用 React 中可能过期的列表。
4. 按固定顺序逐个读取 bytes。
5. 任一读取失败立即停止，不生成下载。
6. 校验数量和总大小上限。
7. 对每个文件计算 SHA-256 和 Base64。
8. 生成并再次检查 JSON UTF-8 字节长度不超过 96 MiB。
9. 所有条目完成后才创建 Blob 并触发一次下载。

导出过程中不 flush、不修改存档，也不更新 mtime。诊断只记录开始、完成或
失败及存档数量，不记录文件名、角色名、摘要或 Base64。

## 8. 完整备份导入

### 8.1 入口和预览

完整备份只从 Home Settings 导入，并使用独立的 `.bhbackup` file input。
它不复用 `.bhprofile` 或 `.nhsave` 的入口。

容器预检后显示一个导入预览：

- 来源产品版本、构建编号和导出时间。
- 个人配置的字段差异。
- 可导入存档。
- 当前构建不兼容、将跳过的存档。
- 损坏、将失败的存档。
- 同名冲突及 Existing/Incoming 身份。

每个同名冲突使用独立的 `Overwrite` checkbox，默认不选中。不存在“全部覆盖”
默认值。玩家确认开始后，选择和已校验 bytes 固定为本次 operation 的输入；
不能继续引用可变化的 file input。

### 8.2 逐文件执行

存档按 `fileName` 固定顺序处理：

1. `incompatible` 直接记为 `skipped`。
2. `damaged` 直接记为 `failed`。
3. 未勾选覆盖的冲突记为 `skipped`。
4. 其他 `importable` 条目逐个调用已有 raw save 事务。
5. 新文件或覆盖文件都使用临时写入、读回校验、rename、flush 和失败回滚。
6. 一个普通失败不停止后续条目。
7. 全部完成后重新枚举 `/save`，不直接拼接 React 列表。

每项结果为：

```ts
type BackupSaveImportResult = {
  fileName: string;
  status: "imported" | "skipped" | "failed";
  reason:
    | "created"
    | "overwritten"
    | "incompatible"
    | "conflict-not-overwritten"
    | "damaged"
    | "write-failed";
};
```

结果页显示 imported、skipped 和 failed 总数，并允许展开逐项结果。诊断日志
只记录三个计数，不记录 `fileName`。

如果某项失败但事务已经成功恢复导入前状态，继续下一项。如果事务和回滚都
失败，当前 IDBFS 状态已经无法证明安全，停止剩余条目并沿用现有 fatal
分类；不能为了满足“继续处理”而在未知存储状态上继续写入。

### 8.3 个人配置最后处理

存档处理和结果汇总完成后，单独显示 profile 确认：

- `Apply Profile`：通过现有单记录 `replaceProfile()` 写入。
- `Keep Current Profile`：不改变当前配置。

profile 应用成功或失败都不回滚已经成功导入的存档。失败时结果页分别报告
“存档结果”和“个人配置未应用”，不能把整个导入报告为全失败，也不能声称
配置已恢复。

profile 应用后界面配置立即生效。NetHack 配置遵守阶段二既有生效规则。

## 9. 浏览器持久存储

### 9.1 平台适配器

新增窄接口包装：

```ts
interface PersistenceAdapter {
  query(): Promise<
    "persistent" | "not-persistent" | "unsupported" | "error"
  >;
  request(): Promise<
    "granted" | "denied" | "unsupported" | "error"
  >;
}
```

- `query()` 使用 `navigator.storage.persisted()`。
- `request()` 只在玩家点击 `Protect Local Data` 后调用
  `navigator.storage.persist()`。
- 缺少 `navigator.storage` 或任一方法时返回 `unsupported`。
- rejected Promise 或同步异常返回 `error`。
- 页面加载时只查询，不自动请求，不循环请求。
- 请求后重新查询一次；浏览器返回 true 时显示 `persistent`。

### 9.2 Settings 展示

Home Settings 的 Data 区段显示：

- `Protected by browser`。
- `Not protected by browser` 和可用的 `Protect Local Data` 按钮。
- `Persistent storage is not supported`。
- `Could not check persistent storage`。

说明文字必须准确指出：授权只降低浏览器因磁盘压力自动清理本来源数据的可能，
玩家清除网站数据、删除浏览器配置或更换来源仍会失去本地数据。不得使用
“backed up”、“synced”或“cloud”描述该状态。

## 10. 清除本地数据

### 10.1 范围

`Clear Local Data` 只在 Home Settings 提供，只在没有活动 session 时执行。
它清除：

- `/save` 挂载点中 BlissHack 管理的文件，包括正式存档和遗留临时文件。
- `localStorage["blisshack.profile.v1"]`。
- `localStorage["blisshack.diagnostics.v1"]`。
- 当前页面中 profile 和 diagnostics 对应的内存状态。

它不调用 `localStorage.clear()`，不删除其他 key，不调用来源级
`indexedDB.deleteDatabase()`，不处理其他网站或其他来源的数据。

### 10.2 确认界面

确认对话框列出：

- 将删除的正式存档数量。
- 是否存在已保存的个人配置。
- 是否存在诊断日志。

对话框提供 `Export Full Backup`，且导出完成不会自动确认清除。玩家必须输入
区分大小写的固定文本：

```text
CLEAR BLISSHACK DATA
```

只有文本完全匹配且没有其他 operation 时，`Clear` 才启用。

### 10.3 执行和补偿

清除不是浏览器提供的跨 IDBFS 与 localStorage 事务。实现使用有界快照和补偿，
避免普通失败留下无提示的混合状态：

1. 通过 Home operation 门禁阻止 session 启动和其他数据操作。
2. 保存 `/save` 当前直接子文件的 bytes，以及两个已知 localStorage key 的
   原始字符串。
3. 删除 `/save` 中的 BlissHack 文件并执行 `syncfs(false)`。
4. 逐个删除两个已知 localStorage key。
5. 任一步失败时，尝试恢复文件和已删除 key，并再次 flush。
6. 补偿成功时显示可恢复错误，继续使用当前 module 和当前内存配置。
7. 补偿失败时进入 fatal，因为应用不能再证明磁盘和内存状态一致。
8. 全部成功后清空 profile/diagnostics 内存状态，废弃旧 prepared module。
9. 创建全新 module，重新 initialize 和枚举，再回到 Home。

成功后 profile 使用默认值，旧诊断事件不可再导出。新 module 启动产生的新
诊断事件属于清除后的新日志世代，不恢复旧事件。

## 11. UI 和可访问性

Settings 在现有 Profile 区段之后增加一个不嵌套卡片的 `Data` 区段：

- 持久存储状态和 `Protect Local Data`。
- `Export Full Backup`。
- `Import Full Backup`。
- `Clear Local Data`。

所有长操作显示稳定的 pending 状态并禁用会竞争当前 module 的命令。按钮使用
现有 lucide 图标。文件 input 保持隐藏但有独立可读名称和 `.bhbackup` accept。

所有 modal 必须：

- 有 `role="dialog"` 或危险确认使用 `role="alertdialog"`。
- 有可读名称和 `aria-modal="true"`。
- 打开时把焦点放入 modal。
- Tab 和 Shift+Tab 保持在 modal 内。
- Esc 只取消当前可取消步骤。
- 关闭后把焦点返回触发按钮。
- operation 已开始后不允许用 Esc 或背景点击中断事务。

完整备份预览、导入结果和清除确认不能放进现有 Settings 表单的嵌套 form。
Settings 有未保存 draft 时：

- 导出使用当前已应用 profile，不包含未 Apply 的 draft。
- 导入或清除前先要求玩家丢弃或保存 draft。
- 不能把未保存 draft 隐式写入备份或持久存储。

## 12. 生命周期和并发边界

阶段三不引入第二个 module。所有需要 `/save` 的操作使用 Settings 打开前已经
准备好的同一个 module。

session manager 的 Home operation 门禁扩展为统一的数据 operation 边界：

- raw save 导入、导出和删除。
- 完整备份导入和导出。
- 清除本地数据。
- session 启动。

完整备份导出必须等待先前 operation 完成。批量导入和清除从开始到最终重新枚举
期间只占用一次门禁，内部逐文件调用不能再次竞争外层门禁。

阶段四会在这个边界外再增加 Web Locks API。阶段三接口应把整个操作表示为一个
回调，以便阶段四能够在获得跨页面锁并重新 populate 后执行同一个回调；本阶段
不提前实现 `localStorage` 心跳或 `BroadcastChannel` 锁。

## 13. 错误和诊断

新增稳定诊断事件：

```text
storage.rescue_export_completed
storage.rescue_export_failed
backup.export_completed
backup.export_failed
backup.import_rejected
backup.import_completed
storage.persistence_granted
storage.persistence_denied
storage.persistence_unsupported
storage.persistence_failed
local_data.clear_completed
local_data.clear_failed
local_data.clear_rollback_failed
```

`DiagnosticDetail` 只扩展非敏感计数和结果字段，例如 imported、skipped、
failed。不得记录角色名、文件名、摘要、Base64、profile 值或 raw bytes。

错误分类：

- 文件格式、摘要、Base64、兼容性、玩家取消、单文件写入失败且回滚成功：
  可恢复。
- 持久存储 API unsupported、denied 或 throw：warning，不影响游戏。
- 完整备份导出任一读取失败：可恢复，但不产生下载。
- 清除或单文件导入的 rollback 失败：fatal。
- 清除成功后的新 module 创建失败：沿用 module-level fatal。

## 14. 代码职责和预计文件

新增：

```text
frontend/src/backup/backup-file.ts
frontend/src/backup/backup-file.test.ts
frontend/src/backup/backup-operations.ts
frontend/src/backup/backup-operations.test.ts
frontend/src/storage/persistence.ts
frontend/src/storage/persistence.test.ts
frontend/src/storage/local-data.ts
frontend/src/storage/local-data.test.ts
```

修改：

```text
frontend/src/storage/storage-service.ts
frontend/src/storage/storage-transaction.ts
frontend/src/nethack-bridge.ts
frontend/src/session/session-manager.ts
frontend/src/settings/profile-store.ts
frontend/src/settings/ProfileProvider.tsx
frontend/src/diagnostics/diagnostic-log.ts
frontend/src/screens/SavePickerPopover.tsx
frontend/src/screens/SettingsScreen.tsx
frontend/src/App.tsx
frontend/src/App.css
对应单元测试和 Playwright 测试
```

职责划分：

- `backup-file.ts`：纯数据格式、限制、UTF-8、Base64、SHA-256 和规范化。
- `backup-operations.ts`：导出快照、导入预检、逐文件结果聚合。
- `storage-service.ts`：正式存档枚举、精确读写、批处理原语和 IDBFS flush。
- `storage-transaction.ts`：单个正式路径的导入与回滚，不感知 JSON。
- `persistence.ts`：StorageManager 能力检测和请求。
- `local-data.ts`：已知 key allowlist、快照、删除和补偿。
- `session-manager.ts`：唯一 module、operation 门禁、重新枚举和清除后重建。
- React screen：预览、玩家决定、进度、结果和焦点，不直接操作 FS。

本阶段不修改：

```text
win/shim/winshim.c
frontend/public/nethack.js
frontend/public/nethack.wasm
frontend/public/nethack-runtime.json
```

## 15. 测试设计

### 15.1 纯数据单元测试

- 空备份、单存档和多存档导出后可重新解析。
- 每个 SHA-256 与 Base64 解码后的 bytes 一致。
- 非规范 Base64、错误 padding、长度不符和摘要不符被拒绝。
- 非 UTF-8、BOM、NUL、非法 JSON、错误 format 和不支持 schema 被拒绝。
- 96 MiB 文件、100 项数量、64 MiB 单项及合计边界分别测试等于和超过。
- `/`、`\`、`..`、绝对路径、控制字符、临时后缀和重复文件名被拒绝。
- 可解析身份下的重复角色和身份/文件名不符被拒绝或分类为 damaged。
- 未知字段不会进入规范化结果。

### 15.2 Storage 和事务测试

- ready、incompatible 和 damaged 正式存档都能原字节导出。
- 非正式文件不进入列表或完整备份。
- 无法解析身份时救援下载名由 hash 稳定生成。
- 完整导出任一读取失败时不返回部分文档。
- 批量导入逐项创建、覆盖、跳过和失败，结果计数准确。
- 某项回滚成功后继续下一项。
- 某项回滚失败后停止并报告 fatal。
- 批量结束后只重新枚举一次。
- 清除只删除 `/save` 管理内容和两个已知 localStorage key。
- 清除普通失败成功补偿；补偿失败进入 fatal。

### 15.3 React 测试

- Data 区段只出现在 Home Settings，不出现在游戏内 Settings。
- `.bhprofile`、`.bhbackup` 和 `.nhsave` 使用三个独立 input 和 handler。
- 备份预览正确列出 profile 差异、分类和冲突。
- 冲突默认不覆盖，且可以逐项选择。
- 导入结束显示 imported、skipped、failed 数量。
- profile 只在存档结果之后单独确认。
- 未保存 Settings draft 会阻止导入和清除。
- 清除确认文本不完全匹配时按钮 disabled。
- 所有 modal 的初始焦点、焦点循环、Esc 和返回焦点正确。
- persist 的 granted、denied、unsupported 和 throw 状态正确。

### 15.4 浏览器集成测试

至少增加以下 Chromium 流程：

1. 创建两个兼容存档，修改 profile，导出完整备份。
2. 清除本地数据并确认刷新后存档为空、profile 为默认值、旧诊断不存在。
3. 导入完整备份，处理存档后应用 profile。
4. 刷新并确认两个兼容存档和 profile 都已恢复。
5. Continue 其中一个存档，证明不是只恢复了列表文本。
6. 注入 fingerprint 不匹配的正式文件，确认 Continue 禁用但 raw export
   和完整备份导出可用。
7. 导入含一个兼容、一个不兼容和一个失败条目的备份，确认结果和最终存储。
8. 模拟 `navigator.storage` 的 granted、denied、unsupported 和 rejected
   Promise。

测试下载的备份必须实际解析、重新计算摘要并比较原字节，不能只检查文件名或
下载事件。

## 16. 分步实施计划

每一步保持构建通过，并作为独立审核点。阶段三不需要重建 WASM。

### 步骤一：存档分类和救援导出

- 把 `SaveValidation` 改成第 3.2 节的结构化状态。
- 统一正式文件名 predicate 和外部备份文件名 validator。
- 允许 incompatible 和 damaged 条目调用 raw export。
- 增加 hash fallback 下载名。
- 更新列表状态文案和测试。

验收：

- 兼容、fingerprint 不匹配、截断和身份损坏四类样本分类稳定。
- 三类正式存档导出 bytes 都与 FS 完全一致。
- Continue 仍只接受 ready。

### 步骤二：备份格式和导出

- 实现 `backup-file.ts` 的 schema、限制、Base64 和 SHA-256。
- 在 storage service 增加重新枚举并读取全部正式存档的快照操作。
- 在 session manager 增加完整备份导出 operation。
- 在 Home Settings Data 区段增加导出按钮和下载。

验收：

- 零存档和多存档备份均可解析。
- 任一读取或摘要失败不生成部分下载。
- 导出包含产品版本、构建编号、profile 和全部正式存档。

### 步骤三：备份预检和导入预览

- 实现 96 MiB 读取前限制和第 6.1 节全部校验。
- 用当前 module 分类存档并读取现有冲突。
- 增加 profile 差异、存档分类和逐项覆盖选择 UI。
- 此步确认按钮只产生执行请求，预览阶段不写任何数据。

验收：

- 所有路径、重复项、大小、编码和摘要攻击样本在写入前失败。
- 预览分类与当前构建和当前 `/save` 一致。

### 步骤四：逐文件导入和结果

- 在一次外层 Home operation 中逐个复用 raw save transaction。
- 普通失败后继续，rollback 失败时停止并 fatal。
- 最后统一重新枚举，显示三个计数和逐项结果。
- 结果后单独确认 profile，并独立报告 profile 结果。

验收：

- 部分成功不会回滚其他成功存档。
- 不兼容存档没有写入当前存储。
- 每个冲突决定和最终计数准确。
- profile 失败不改变存档结果。

### 步骤五：持久存储状态

- 增加可注入的 StorageManager adapter。
- Settings 加入状态查询和玩家主动请求。
- 增加无自动重试的结果文案与诊断事件。

验收：

- granted、denied、unsupported 和 throw 均有单元测试。
- denied 或 unsupported 不禁用现有单页面游戏和备份能力。

### 步骤六：清除本地数据

- 增加精确 key allowlist、IDBFS 文件快照和补偿。
- 增加输入固定文本的危险确认。
- 成功后重置 profile/diagnostics 内存并创建干净 module。
- 增加可恢复失败和 fatal rollback 失败路径。

验收：

- 不调用 `localStorage.clear()` 或来源级数据库删除。
- 成功后刷新仍为空，且可立即开始新游戏。
- 失败补偿后原存档、profile 和诊断仍可读取。

### 步骤七：阶段三综合验收

执行并记录：

```bash
cd frontend
npm run lint -- --deny-warnings
npm test
npm run build
npm run test:integration:wasm
npm run test:integration:browser
git diff --check
```

阶段三没有 C 或 WASM 修改，因此不运行重建命令；真实 WASM 集成测试仍需通过。
完成后更新 `prealpha-3.md` 的阶段三结果，但保留改动供用户审核，用户确认后
再提交阶段实现。

## 17. 本次评审需要确认的决定

1. 完整备份采用第 5.1 节的 schema 1，不加入 ZIP、mtime 或诊断日志。
2. 备份内 profile 使用 `BlissHackProfileV1`，不重复 `.bhprofile` 外层元数据。
3. 不兼容存档导出进备份，但在当前构建导入时跳过而不写入 IDBFS。
4. 损坏存档也进入导出备份；导入当前构建时记为失败。
5. 同名冲突逐项选择，默认不覆盖。
6. 存档逐项处理完成后，再单独确认 profile；两类结果互不回滚。
7. 清除确认文本为 `CLEAR BLISSHACK DATA`，并采用第 10.3 节的补偿流程。
8. 所有阶段三数据管理入口放在 Home Settings；save popover 保留单个 raw
   save 的导入、导出和删除。
