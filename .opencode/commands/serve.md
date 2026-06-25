---
description: 本地预览已复刻的网站
---

先检查 sites/ 目录下列出所有已捕获的站点：

ls sites/

如果 $ARGUMENTS 未提供，列出所有站点并让用户选择。如果提供了站点名，执行：

pnpm site:serve -- "$ARGUMENTS"

启动后告知用户访问地址 (默认 http://localhost:4173) 以及如何验证。
