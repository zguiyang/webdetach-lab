# 工程规则

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
