---
description: 捕获一个网页并保存到本地
---

执行 pnpm setup 检查环境，如果通过则执行：

pnpm site:capture -- "$ARGUMENTS"

捕获完成后，读取 sites/ 下新增目录中的 reports/capture-summary.md，总结捕获结果报告给用户，包括请求数、资源数、截图情况、捕获缺口。
