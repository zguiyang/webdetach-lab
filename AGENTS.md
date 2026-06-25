# 工程规则

## 基本原则

- 这是 Agent 流程实验项目，不是正式应用。
- 优先组合现有 Skill 和 CLI 工具。
- 不要为了形式完整而创建代码。
- Node.js 是项目必要运行环境（配合 tsx 执行 TypeScript 脚本和启动本地 HTTP Server）。
- 只有经过实际流程验证，确认某一步需要自动化时，才创建 TypeScript 脚本。
- 新脚本只解决一个明确问题，需要记录原因、输入、输出和替代的手工步骤。
- 所有持久化脚本使用 TypeScript，不允许 Python 脚本。
- 修复已有页面时采用增量修改，不重写整个页面。
- 每个复刻网站存放在 `sites/<site-name>/` 独立目录。
- Skill 负责流程编排，具体操作优先交给现有工具完成。
- 唯一浏览器自动化工具为 `playwright-cli`，默认启动本地 headed Chrome，使用项目专用 Profile。

---

## 执行前依赖检查

**在任何 Skill 或脚本执行前，MUST 按以下顺序检查依赖。只要有一项不通过，MUST 停止执行，输出缺失项和安装指引。禁止自动安装。**

检查状态定义：
- `PASS` — 可用
- `FAIL` — 不可用，阻塞执行

### D1: Node.js

```bash
node --version
```

要求 v22.x 或 v24.x。不匹配时输出：`当前版本 <version>，需要 v22.x 或 v24.x。请安装 Node.js LTS：https://nodejs.org`

### D2: pnpm

```bash
pnpm --version
```

不可用时输出：`pnpm 未安装。安装方式：npm install -g pnpm 或 brew install pnpm`

### D3: 项目依赖

```bash
pnpm ls --depth=0 2>/dev/null
```

要求 `typescript`、`tsx`、`@types/node`、`parse5`、`@playwright/cli` 均已安装。缺失时输出：`项目依赖不完整，请执行 pnpm install`

### D4: playwright-cli

```bash
./node_modules/.bin/playwright-cli --version
```

要求作为项目依赖通过 `pnpm install` 安装。不可用时输出：`playwright-cli 未安装。请执行 pnpm install`（已配置为项目依赖 `@playwright/cli`）

### D5: Google Chrome

```bash
# macOS 检测
ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null && echo "OK"

# Linux
which google-chrome google-chrome-stable chromium-browser 2>/dev/null
```

不可用时输出：`Chrome 未安装，请安装 Google Chrome。macOS: brew install --cask google-chrome`

### D6: 文件系统

`sites/` 目录 MUST 存在且可写。

```bash
ls sites/ 2>/dev/null && touch sites/.write-test && rm sites/.write-test
```

不可写入时输出：`sites/ 目录不可写，请检查权限`

### D7: 目标 URL 合法性

目标 URL MUST：
- 使用 `http:` 或 `https:` 协议
- 是公开可访问页面，不要求登录
- 不是本地敏感地址（localhost、127.0.0.1、0.0.0.0、::1、169.254.169.254、私有局域网）
- 不是 `file:`、`data:`、`javascript:` 等非 HTTP 协议
- 不含用户凭据（如 `http://user:pass@host/`）

不符合时输出具体原因并停止。

---

### 失败处理

任意依赖为 `FAIL` 时，`overall_status = BLOCKED`，MUST：

1. 输出所有未通过的检查项
2. 输出每项的当前检测结果和所需条件
3. 输出安装或配置方式
4. 提示用户修复后重新执行

MUST NOT：
- 自动安装任何工具或依赖
- 跳过失败项继续执行流程
- 将 `UNKNOWN`（无法确认）当作 `PASS`
- 用截图或部分结果冒充完整流程
- 继续尝试网页复刻或调用任何脚本
