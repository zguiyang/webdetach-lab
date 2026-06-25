---
description: 审计捕获质量
---

Run: `pnpm site:audit-capture -- "$ARGUMENTS"`

Also check `sites/$ARGUMENTS/capture/network.json` and `console.json` for empty data. Output audit conclusion:
- PASS: ready for localization
- WARN: partial gaps, needs repair
- FAIL: needs recapture
