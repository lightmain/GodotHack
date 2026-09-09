# prealpha-3 发布验收

本文记录 prealpha-3 阶段六的兼容性、可访问性、性能和发布验收结果。
自动验收通过不代替最后的线上全新浏览器验证和人工游玩。

## 1. 测试环境

- 机器：Apple M4 Pro，48 GB 内存，arm64。
- 系统：macOS 26.5.1。
- Node.js：项目固定版本 24；性能采集 shell 为 Node.js 22.21.1，浏览器内
  测量不依赖 Node.js 运行时。
- Chromium：Chrome for Testing 151.0.7922.34。
- Firefox：Playwright Firefox 153.0。
- WebKit：Playwright WebKit 26.5。
- 视口：1280 × 900。
- 构建路径：`/BlissHack/`。

Firefox 在当前 TRAE macOS 沙箱内无头启动会触发 Software WebRender
framebuffer 映射失败，因此本地 Firefox 使用 headed 模式。GitHub Actions
在 Ubuntu 上使用标准无头模式。

## 2. 浏览器兼容性

Chromium 运行完整浏览器回归。Firefox 和 WebKit 使用
`playwright.compat.config.ts` 中的发布基础组，覆盖：

- Home 和 New Game。
- 保存、返回 Home、刷新和 Continue。
- 个人配置导出、预览和导入。
- 完整备份导出、清除和恢复。
- raw save 导出、删除、导入和继续。
- Web Locks 双页面竞争、取消、关闭所有者页面和重试。

本地结果：

| 浏览器 | 套件 | 结果 |
| --- | --- | --- |
| Chromium 151 | 完整浏览器套件 | 34/34 |
| Firefox 153 | 完整浏览器套件 | 34/34 |
| Firefox 153 | 发布基础组 | 6/6 |
| WebKit 26.5 | 发布基础组 | 6/6 |

Firefox 和 WebKit 基础组由手动 workflow
`.github/workflows/browser-compat.yml` 运行。当前不把它加入每次 push，
避免在兼容性基线稳定前扩大普通 CI 时间。

## 3. 可访问性

自动浏览器回归确认：

- Settings、个人配置导入、完整备份导入、锁冲突和清除数据 modal 均有
  可访问名称和正确的 `dialog` 或 `alertdialog` 语义。
- 打开 modal 后背景 Settings 内容设置为 `inert`。
- 初始焦点进入 modal，Tab 和 Shift+Tab 在 modal 内循环。
- Cancel 或 Escape 关闭 Settings/profile modal 后，焦点返回触发按钮。
- profile、完整备份和清除数据错误通过 `aria-describedby` 关联相应操作；
  无效文件输入同时设置 `aria-invalid`。
- 永久背包有 `Inventory` region 名称，可获得焦点并使用浏览器原生滚动。
- 永久背包折叠按钮显式位于 Tab 顺序中，兼容 WebKit 的键盘导航行为。

字符地图逐格朗读不属于本版本范围。

## 4. 性能基线

这些数据用于后续版本比较，不是共享 CI 的绝对耗时门槛。页面流程数据取五次或
三次本地运行的中位数；heap 是一次强制 GC 前后观察值。

| 项目 | 结果 |
| --- | ---: |
| 首次导航到 Home 可操作 | 约 95 ms |
| New Game 到名字输入，热启动 | 约 68 ms |
| New Game 到名字输入，首次 | 465 ms |
| 保存并返回 Home | 约 29 ms |
| 刷新到 Home 可操作 | 约 43 ms |
| Continue 到角色状态可见 | 约 69 ms |
| 20 次 module 创建/退出 | 热启动约 65–71 ms/次 |
| 20 次 module 前 heap | 3,111,055 bytes |
| 20 次 module 后 heap | 4,948,639 bytes |

单次 heap 增量为 1,837,584 bytes。循环耗时没有持续增长，但该观察不能单独证明
不存在泄漏；长流程测试继续负责检测 callback 和会话生命周期回归。

当前构建资源：

| 资源 | 字节长度 |
| --- | ---: |
| 前端 JavaScript | 331,823 |
| 前端 CSS | 27,253 |
| `nethack.js` | 95,047 |
| `nethack.wasm` | 6,444,763 |

永久背包使用测试专用 Vite 页面直接渲染生产 React 组件和生产 CSS。React
Profiler 记录一次从前一规模更新到下一规模的 commit 时间；滚动时间记录设置
到底部后至下一动画帧：

| 条目 | React commit | 滚动响应 | DOM 行数 | 滚动结果 |
| ---: | ---: | ---: | ---: | --- |
| 20 | 3.5 ms | 36.8 ms | 20 | 内容未超过容器 |
| 100 | 4.9 ms | 7.9 ms | 100 | 到达底部 |
| 300 | 11.3 ms | 8.0 ms | 300 | 到达底部 |

可使用 `npm run test:performance` 重复该检查。测试只设置宽松的异常阻塞门槛，
具体数值以本文基线比较。

## 5. 自动验收

发布候选需要运行：

```bash
cd frontend
npm run lint
npm test
npm run build
npm run test:integration:wasm
npm run test:integration:browser
npm run test:long
npm run test:performance
npm run test:integration:compat
```

固定 Emscripten 6.0.9 和 Node.js 24 的 WASM 重建仍按照
`doc/BlissHack/build-process.md` 单独执行。

## 6. 待人工验收

阶段六在以下项目完成前不应标记为最终通过：

1. 在已部署站点上用全新 Chromium、Firefox 和 Safari 浏览器配置完成基础流程。
2. 检查线上 `/BlissHack/` 子路径、缓存、下载、IndexedDB 和 Web Locks。
3. 使用永久背包完成拾取、丢弃、装备、保存和继续。
4. 检查键盘焦点、对话框焦点返回和永久背包滚动。
5. 完成至少 30 分钟桌面游玩，确认没有 fatal 或持续性能下降。
