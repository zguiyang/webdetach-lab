# Tool Strategy

## Browser automation

唯一使用 `playwright-cli`。

## Default launch mode

```bash
playwright-cli -s=webdetach open "<URL>" \
  --browser=chrome \
  --headed \
  --persistent \
  --profile=.webdetach/browser-profile
```

自动启动本地 headed Chrome，使用项目专用持久化 Profile。

启动前 MUST 执行 `playwright-cli open --help` 确认参数格式。

## Optional: attach mode

仅用户明确要求复用时使用：

```bash
playwright-cli attach --cdp=chrome -s=webdetach
```

需要用户手动开启 Chrome Remote Debugging。默认流程不使用。

## Session

固定使用 `webdetach`。后续所有命令加 `-s=webdetach`。

## Failure behavior

playwright-cli 或 Chrome 不可用时停止。不切换到其他浏览器工具。

## Non-browser operations

TypeScript 脚本通过项目本地 `tsx` 执行。

## Local site access

```bash
pnpm site:serve -- <site-name>
```
