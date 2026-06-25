# webdetach-lab

研究通过 Agent Skill、`playwright-cli` 和 TypeScript 脚本完成网页源站解耦复刻。

## 环境要求

- Node.js 22 或 24
- pnpm
- Google Chrome
- playwright-cli

## 安装

```bash
pnpm install
pnpm typecheck
pnpm site:capture -- <url> [--force]
pnpm site:audit-capture -- <site-name>
```

## 本地网站服务

```bash
pnpm site:serve -- <site-name> [--port <port>]
```

默认 `http://127.0.0.1:4173`。TypeScript 脚本通过 `tsx` 执行。

## 目录结构

- `sites/` — 复刻后的网站输出目录
- `.agents/skills/web-detach/` — 项目 Skill、规则与脚本
- `.webdetach/` — 浏览器 Profile（不提交 Git）
