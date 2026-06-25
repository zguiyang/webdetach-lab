# web-detach

**目标**：输入一个公开网页 URL，通过 `playwright-cli` 启动本地 Chrome 打开页面，将其运行所需的全部资源保存到本地，通过本地 HTTP Server 访问。

**规则**：硬性规则见 `rules.md`，工具策略见 `references/tool-strategy.md`。

---

## 浏览器工具

- **主要工具**：`playwright-cli`（项目依赖 `@playwright/cli`，通过 `pnpm install` 安装），负责页面交互、截图、DOM 捕获
- **资源捕获**：通过 Playwright `run-code`（`page.on('response')`）在浏览器会话内完成，零额外请求捕获所有响应体
- **默认模式**：自动启动本地 headed Chrome + 专用持久化 Profile
- **Session**：固定使用 `webdetach`
- **Profile**：`.webdetach/browser-profile`（项目专用，不提交 Git）
- **启动命令**：`./node_modules/.bin/playwright-cli` 或 `pnpm exec playwright-cli`
- **禁止**：agent-browser、无头浏览器、其他浏览器工具

---

## 浏览器启动

默认命令：

```bash
pnpm exec playwright-cli -s=webdetach open "<TARGET_URL>" \
  --browser=chrome \
  --headed \
  --persistent \
  --profile=.webdetach/browser-profile
```

或者（等效）：

```bash
./node_modules/.bin/playwright-cli -s=webdetach open "<TARGET_URL>" \
  --browser=chrome \
  --headed \
  --persistent \
  --profile=.webdetach/browser-profile
```

执行前 MUST 通过 `pnpm exec playwright-cli open --help` 确认当前版本参数格式。

## Remote Debugging（可选模式）

仅当用户明确要求复用时：

```bash
pnpm exec playwright-cli attach --cdp=chrome -s=webdetach
```

此时用户需要在 Chrome 中开启 Remote Debugging。默认流程不使用此模式。

---

## 执行流程

### 阶段 1：启动与检查

1. 检查环境（Node.js 22/24、pnpm、playwright-cli、Chrome）
2. 通过 `playwright-cli -s=webdetach open` 启动 headed Chrome
3. 等待页面加载完成
4. 检查页面状态（`ACCESS_OK` / `ACCESS_BLOCKED` / `ACCESS_INCOMPLETE`）
5. 如遇 Cookie 同意或验证码，暂停并提示用户在 Chrome 窗口中处理
6. 状态非 `ACCESS_OK` 时停止

### 阶段 2：捕获（Capture）

1. 生成站点名称，创建 `sites/<site-name>/` 完整目录结构
2. 写入 `site.json`（status: `CAPTURING`）
3. 保存首屏截图、完整页面截图、滚动后截图
4. 保存渲染后 DOM 与可见文本
5. 获取 Network 请求、Console 日志
6. 生成资源清单（Network + DOM 去重）
7. 完整滚动页面，触发导航菜单、下拉、Tab、Accordion、Carousel 等安全交互
8. 观察并记录交互后新增资源
9. 在导出 `rendered.html` 前，MUST 确认关键动态区块已经稳定：
   - 头部导航和搜索栏已完成初始化
   - 首屏分类和推荐区已出现最终文本，不是占位骨架
   - 侧边栏/浮层类异步组件已完成首轮挂载
10. `rendered.html`、截图、`network.json`、`console.json` MUST 来自同一浏览器会话，同一稳定时刻
9. 更新 `site.json` 统计与状态
10. 生成 `reports/capture-summary.md`

### 阶段 2（续）：捕获后验证与结果报告

1. 从 `site.json` 的 `name` 字段获取站点名称
2. 后台启动 `pnpm site:serve -- <site-name>`，监听 `127.0.0.1:4173`
3. 验证页面可访问：
   - **首选**：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173`，返回 `200` 则通过
   - **回退**：直接读取 `sites/<site-name>/index.html`，确认包含 `<html>` 或 `<!DOCTYPE` 标记（有效 HTML）则通过
4. 验证通过 → **仅输出**"通过"，不附加任何说明文字
5. 停止本地预览服务
6. 输出用户预览命令：`pnpm site:serve -- <site-name>`

### 阶段 3：本地化（Localize）

**基线保护**：`capture/rendered.html` 是不可修改的视觉基准。`index.html` MUST 先通过字节级复制生成，再增量修改资源引用。

**图片阶段**（`pnpm site:localize-images -- <site-name>`）：

1. 使用 `parse5` 结构化解析 HTML，获取属性源码位置
2. 仅定位图片相关属性（src、srcset、data-src 等），构建 offset 补丁
3. 从后向前应用补丁，HTML 其余字节不变
4. 懒加载图片（data-src → src）本地化后归一化为直接 src
5. 检查远程图片数为 0
6. 浏览器回归验证，通过后进入下一阶段

**禁止操作**：
- 删除或修改 `<base>` 标签
- 重写 DOM 结构
- 格式化或重新序列化 HTML
- 修改内联 `<script>` 内容
- 修改内联 `<style>` 内容
- 使用正则整体改写 HTML
- 将导航链接（`<a href>`）当静态资源替换

**验证**：每完成一个资源类别本地化，MUST 启动页面并与基准截图对比。视觉回归时 MUST 恢复上一版本。

CSS、字体、JS 和接口响应留在后续阶段处理。

### 阶段 4：验证与修复（Verify & Repair）

启动 `pnpm site:serve`，检查 Console/Network，增量修复。最多 3 轮。

### 阶段 5：断联测试（Offline Test）

屏蔽原站域名，验证页面独立运行。

---

## 离线模式（Offline Mode）

通过 `--mode offline` 参数开启，区别于 online 模式的完整离线化流程：

### 配置

```bash
pnpm site:capture -- <url> --mode offline
```

目录产物新增 `webdetach.json`：
```json
{
  "sourceUrl": "https://example.com",
  "mode": "offline"
}
```

### 捕获阶段差异

1. 浏览器打开页面后，通过 `playwright-cli run-code` 执行资源捕获脚本
2. 脚本中 `page.on('response')` 监听每个响应，保存到 `assets/mirror/<protocol>/<host>/<path>`
3. **零额外请求**：不主动 fetch，只捕获页面正常加载过程中的响应
4. 所有静态资源（HTML/CSS/JS/图片/SVG）存盘后继续截图和 DOM 捕获

### 本地化阶段差异

1. `localize-assets.ts` 读取 `webdetach.json` 判断 mode
2. `offline` 模式跳过网络下载，直接从 `assets/mirror/` 检查文件存在
3. 使用 parse5 精准替换静态资源属性为相对路径 `./assets/mirror/...`
4. 字体引用不替换，浏览器自然 fallback 系统字体（版权规避）
5. 不处理 runtime XHR/Fetch 响应和 JS 域名重写

### Server 阶段差异

```bash
pnpm site:serve -- <site> --offline
```

- 禁止任何代理回退到原站
- 移除 `/__origin__/` 运行时路由
- 文件不存在直接 404

### 访问方式

同一份 `index.html` 支持：
- 双击 `index.html`（`file://`）：图片/CSS/JS 正常加载（字体系统 fallback）
- `pnpm site:serve -- <site>`：所有功能完整

---

## 环境要求

- Node.js 22 或 24
- pnpm
- 项目依赖已安装（typescript、tsx、@types/node、parse5、@playwright/cli）
- playwright-cli（通过 `@playwright/cli` 安装）
- Google Chrome（本地安装）

## 阻止条件

以下任一条件缺失时停止：

- Node.js 版本不符合
- pnpm 不可用
- 项目依赖未安装
- playwright-cli 不可用
- Chrome 不可用
- `sites/` 不可写
- 本地 HTTP Server 无法启动
- 页面状态为 `ACCESS_BLOCKED`

## 新手快速开始

```bash
# 1. 克隆项目
git clone <repo>

# 2. 安装所有依赖（含 playwright-cli）
pnpm install

# 3. 运行环境检查
pnpm setup

# 4. 捕获网页
pnpm site:capture -- <target-url>
```

## Profile 规则

- 专用目录 `.webdetach/browser-profile`，不提交 Git
- 不复制到 `sites/`
- 不导出 Cookie、Token 或 Storage
- MAY 保留公开页面的访问状态
- 用户可自行删除该目录重置状态

## 隐私规则

- 使用项目专用 Profile，不访问用户日常 Chrome Profile
- 不保存 Authorization Header
- Network 报告脱敏敏感 Header
