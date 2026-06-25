# webdetach-lab

通过 AI Agent (opencode) + `playwright-cli` + TypeScript 脚本，完成**网页源站解耦复刻**。

输入一个公开网页 URL，将其运行所需的全部资源（HTML、CSS、JS、图片、字体、API 响应等）保存到本地，最终通过本地 HTTP Server 即可访问该页面，不再依赖原站。

> 这是 Agent 流程实验项目，不是正式应用。

## 必要依赖

| 依赖 | 版本要求 | 用途 | 验证命令 |
|------|---------|------|---------|
| Node.js | v22.x 或 v24.x | TypeScript 脚本执行、本地 HTTP Server | `node --version` |
| pnpm | 任意现代版本 | 包管理 | `pnpm --version` |
| Google Chrome | 最新稳定版 | 浏览器渲染（headed 模式） | `/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --version` |
| playwright-cli | 最新 | 唯一浏览器自动化工具 | `playwright-cli --version` |

### 项目 npm 依赖

通过 `pnpm install` 自动安装：

| 包名 | 用途 |
|------|------|
| `typescript` | 类型检查 |
| `tsx` | 直接执行 TypeScript 脚本 |
| `@types/node` | Node.js 类型定义 |
| `parse5` | HTML 结构化解析（资源本地化） |
| `@playwright/cli` | **浏览器自动化工具 playwright-cli**（项目依赖，无需全局安装） |

## 安装

```bash
git clone <repo-url>
cd webdetach-lab
pnpm install
pnpm setup          # 环境检查（推荐首次运行）
pnpm typecheck      # 类型检查
```

## 可用脚本

```bash
pnpm setup                               # 环境检查（检查 Node.js/pnpm/Chrome/项目依赖）
pnpm site:capture -- <url>               # 捕获网站
pnpm site:audit-capture -- <site-name>   # 审计捕获质量
pnpm site:localize-images -- <site-name> # 图片本地化
pnpm site:localize-assets -- <site-name> # 资源本地化
pnpm site:serve -- <site-name>           # 启动本地 HTTP Server
pnpm typecheck                           # 类型检查
```

## 目录结构

```
webdetach-lab/
├── .agents/
│   └── skills/web-detach/     — Skill、规则、脚本、提示词
│       ├── SKILL.md           — 流程编排入口
│       ├── rules.md           — 硬性执行规则
│       ├── prompts/           — Agent 阶段提示词
│       ├── references/        — 工具策略等引用文档
│       └── scripts/           — TypeScript 工具脚本
├── sites/<site-name>/         — 复刻网站输出目录
│   ├── index.html             — 可访问的本地页面
│   ├── site.json              — 站点元数据
│   ├── assets/                — 本地化资源
│   ├── capture/               — 捕获阶段原始数据
│   ├── data/                  — Mock 数据
│   └── reports/               — 审计报告
├── .webdetach/                — 浏览器 Profile（不提交 Git）
├── AGENTS.md                  — AI 助手工程规则
└── README.md
```

## AI Agent 执行流程

项目通过 opencode + web-detach Skill 驱动 5 个阶段：

1. **启动与检查** — 检查环境、启动 Chrome、验证页面可访问
2. **捕获** — 截图、保存 DOM、获取 Network/Console
3. **本地化** — 将远程资源下载到本地，重写引用路径
4. **验证与修复** — 启动 HTTP Server，增量修复（最多 3 轮）
5. **断联测试** — 屏蔽原站，验证独立运行

详见 `.agents/skills/web-detach/SKILL.md`。

## 注意事项

- 唯一浏览器工具为 `playwright-cli`，禁止使用 agent-browser 或其他工具
- 固定使用 Session `webdetach`，专用 Profile `.webdetach/browser-profile`
- 所有持久化脚本使用 TypeScript，禁止 Python
- 捕获阶段 MUST 使用 headed Chrome（非无头模式）
- 捕获前 MUST 确保依赖完整（参见 AGENTS.md 依赖检查规则）
