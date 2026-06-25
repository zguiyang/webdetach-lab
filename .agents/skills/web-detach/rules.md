# 规则

## 网站输出目录

所有复刻的网站在 `sites/<site-name>/`，格式见 `sites/README.md`。

一个目录只对应一个目标网页副本。目录之间不共享业务资源。

## 浏览器工具

唯一使用 `playwright-cli`（项目依赖 `@playwright/cli`）。默认通过 `./node_modules/.bin/playwright-cli -s=webdetach open` 启动本地 headed Chrome，使用专用持久化 Profile `.webdetach/browser-profile`。固定 Session `webdetach`。禁止使用 agent-browser、无头浏览器或其他浏览器工具。

## Profile

`.webdetach/` 不提交 Git，不复制到 `sites/`，不导出 Cookie/Token/Storage。用户可自行删除重置。不使用用户日常 Chrome Profile。

## 抓取目标

MUST 尽可能获取并本地保存：HTML、CSS、JS（含动态 chunk）、图片/SVG、字体、视频/音频、CSS `url()`、`srcset`、Worker、WASM、Fetch/XHR 公开响应、滚动和交互触发的展示型资源。

MUST NOT 处理：登录、注册、用户数据、Cookie、Token、Authorization、支付、真实表单提交、用户中心、私有接口。

## 捕获一致性

`capture/rendered.html`、截图、`capture/network.json`、`capture/console.json` MUST 来自同一浏览器会话，不允许分多次补抓后混写到同一站点目录。

导出 `rendered.html` 前 MUST 等待关键动态区块稳定，至少覆盖：
- 头部导航初始化完成
- 首屏分类或主推荐区出现最终文本
- 页面尾部异步挂载组件完成首轮渲染

如果 `network.json` 或 `console.json` 为空，而页面仍包含大量远程脚本或异步脚本，这次捕获视为无效，需要重抓。

## 资源本地化

**基线保护**：`capture/rendered.html` 是不可修改的视觉基准。`index.html` MUST 先通过字节级复制生成，再增量修改资源引用。

**HTML 解析**：MUST 使用结构化解析器（如 `parse5`），禁止正则整体改写 HTML。通过属性源码 offset 构建局部补丁，从后向前应用。HTML 其余字节 MUST 不变。

**图片阶段**：执行 `pnpm site:localize-images -- <site-name>`。处理的属性含 src、srcset、data-src、data-srcset、data-lazy-src、data-original、poster、SVG href/xlink:href。懒加载图片本地化后归一化为直接 src。完成后远程图片 MUST 为 0。

**禁止**：删除 `<base>`、重写 DOM、格式化 HTML、修改内联脚本/样式、将导航链接当静态资源替换。

**验证**：每完成一个资源类别本地化，MUST 启动页面并与基准截图对比。视觉回归时 MUST 恢复上一版本。

**脚本**：持久化本地化脚本 MUST 使用 TypeScript。禁止使用临时 Python/Bash 脚本修改正式页面。

默认全部保存到网站目录，使用相对路径。最终页面 MUST NOT 依赖原站业务资源。通用第三方库优先本地化。分析、广告、追踪、客服和埋点 MUST 阻止或移除。

## 本地 HTTP Server

通过 `pnpm site:serve -- <site-name>` 访问。绑定 `127.0.0.1:4173`。

## 修复规则

只修改 `sites/<site-name>/`。修复前先检查 Console、Network。增量修复，最多 3 轮。优先：资源路径 → 404 → MIME → 接口数据 → JS 顺序 → 局部 CSS/DOM。不重写整个页面。

## 脚本规范

所有持久化脚本使用 TypeScript，通过 `tsx` 执行。禁止 Python 脚本。脚本单一职责、可重复执行、失败时非零退出码。
