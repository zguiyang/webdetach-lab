---
description: 审计捕获质量，检查远程资源、缺口等
---

执行 pnpm site:audit-capture -- "$ARGUMENTS"，读取审计结果。

同时检查 sites/$ARGUMENTS/ 目录下的 capture/network.json 和 capture/console.json 是否为空，资源是否完整。输出审计结论：
- PASS：可以进入本地化阶段
- WARN：部分缺口，需要修复
- FAIL：需要重新捕获
