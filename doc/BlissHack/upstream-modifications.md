# BlissHack 上游修改清单

本文记录 BlissHack 相对于 `upstream/NetHack-5.0` 的上游源码修改。目标是让
后续上游合并能够逐项复查本地调用链、许可证标记、导出接口和回归测试。

本文只列出对 NetHack 上游文件的修改。`frontend/`、`.github/` 和
`doc/BlissHack/` 下的 BlissHack 自有文件不属于这份清单。

## 1. 当前比较方法

更新本地 upstream 引用后运行：

```bash
git fetch upstream NetHack-5.0
git diff --name-status upstream/NetHack-5.0...HEAD -- \
  include src sys/libnh sys/unix/hints win/shim
git diff upstream/NetHack-5.0...HEAD -- \
  sys/unix/hints/include/cross-pre2.500 win/shim/winshim.c
```

截至 prealpha-3 阶段一，相关 diff 只应包含：

```text
M sys/unix/hints/include/cross-pre2.500
M win/shim/winshim.c
```

## 2. 修改记录

### 2.1 角色选择退出语义

- **文件**：`win/shim/winshim.c`
- **引入提交**：`2f1688501 fix: honor quit during character selection`
- **目的**：保留 `genl_player_setup()` 返回 false 时的退出语义，避免玩家在
  `[ynaq]` 提示中选择 `q` 或 Escape 后仍进入 `newgame()`。
- **行为依据**：
  `doc/BlissHack/shim-interface-reference.md` 第 6.1 节。
- **回归测试**：
  - `frontend/src/nethack-bridge.test.ts`
  - `frontend/src/session/session-manager.test.ts`
  - `frontend/test/integration-tests/browser/playable-frontend.spec.ts`

### 2.2 浏览器存档启动 helper

- **文件**：`win/shim/winshim.c`
- **引入提交**：
  `be7b8d035 feat: add browser save continuation`
- **目的**：增加设置玩家名、要求只能恢复已有存档和读取存档 fingerprint 的
  三个窄接口。接口只在启动前使用，不允许 React 在 Asyncify 等待期间重入
  NetHack。
- **导出函数**：
  - `shim_graphics_set_player_name`
  - `shim_graphics_set_restore_required`
  - `shim_graphics_get_save_fingerprint`
- **行为依据**：
  `doc/BlissHack/shim-interface-reference.md` 第 6.2 节。
- **回归测试**：
  - `frontend/test/integration-tests/wasm-test.mjs`
  - `frontend/src/nethack-bridge.test.ts`
  - `frontend/src/storage/storage-service.test.ts`
  - `frontend/src/session/session-manager.stage-two.test.ts`
  - Continue 相关 Playwright 流程

### 2.3 Emscripten 导出列表

- **文件**：`sys/unix/hints/include/cross-pre2.500`
- **引入提交**：
  `be7b8d035 feat: add browser save continuation`
- **目的**：把第 2.2 节的三个 helper 和配对释放内存所需的 `_free` 加入
  `EXPORTED_FUNCTIONS`。
- **行为依据**：
  `doc/BlissHack/shim-interface-reference.md` 第 6.2 节。
- **回归测试**：
  - `frontend/test/integration-tests/wasm-test.mjs`
  - `frontend/src/nethack-bridge.test.ts`

### 2.4 许可证和源码修改标记

- **文件**：`win/shim/winshim.c`
- **引入提交**：
  `18d0818bb docs: mark BlissHack shim modification`
- **目的**：在上游文件头显著记录 BlissHack 修改者、日期和修改范围。
- **验收**：人工检查文件头、本文和 shim 接口参考三处描述一致。

### 2.5 游戏内 Settings 安全边界协议

- **文件**：`win/shim/winshim.c`
- **引入提交**：本阶段提交 `feat: add runtime settings shim protocol`
- **目的**：
  - 在 WASM 输入回调末尾附加 `program_state.input_state`，让前端只在
    `commandInp` 时提供暂停入口。
  - 在 `get_nh_event()` 命令边界交换七项动态配置的版本化 32-bit 快照。
  - 只接受经过位级校验的固定字段，并在当前 C 调用栈内使用
    `parseoptions()` 应用，避免 Asyncify 等待期间从 React 重入 WASM。
  - 使用无交互消息的解析上下文并补做必要刷新，避免批量应用触发
    `--More--`。
- **ABI 范围**：只修改 Emscripten 回调参数；原生 `libnethack.a` ABI
  保持不变。
- **行为依据**：
  `doc/BlissHack/shim-interface-reference.md` 第 6.3 节。
- **回归测试**：
  - `frontend/src/settings/runtime-settings-protocol.test.ts`
  - `frontend/src/nethack-bridge.test.ts`
  - `frontend/test/integration-tests/wasm-test.mjs`
  - Settings 与暂停相关 Playwright 流程

## 3. 上游合并检查

每次从 `upstream/NetHack-5.0` 合并后必须：

1. 重新运行第 1 节的比较命令，确认没有本地修改被静默丢失。
2. 检查 `shim_player_selection()`、`genl_player_setup()`、存档 header 生成和
   `EXPORTED_FUNCTIONS` 的调用链。
3. 确认每个修改过的上游 C 文件仍保留 BlissHack 许可证标记。
4. 使用 `.emscripten-version` 指定的工具链运行 `npm run build:wasm`。
5. 一起更新并审核 `nethack.js`、`nethack.wasm` 和
   `nethack-runtime.json`。
6. 运行 WASM 集成测试、Chromium 浏览器测试和受影响的专项测试。

新增上游修改时，必须在同一阶段补充文件、目的、提交、调用链依据和测试，
不得只在提交信息中记录。
