# Environment Audit

## Audit Metadata

- **Date**: 2026-06-25 14:40 CST
- **Operating System**: Darwin 25.5.0 arm64 (macOS)
- **Shell**: /bin/zsh
- **Current Agent**: opencode (deepseek-v4-pro)
- **Project**: webdetach-lab

---

## Available Skills

### Skills Relevant to Web Detach

| Skill | Location | Capabilities | Status | Notes |
|---|---|---|---|---|
| `agent-browser` | `~/.agents/skills/agent-browser/` + `/opt/homebrew/bin/agent-browser` v0.27.3 | CDP-based browser automation: open, snapshot (a11y tree), click, fill, type, screenshot, extract, evaluate JS, network monitoring, multi-tab | **AVAILABLE** | Installed via Homebrew. Full Chrome control via CDP. Preferred for page navigation, DOM reading, interaction. |
| `chrome-devtools` | `~/.agents/skills/chrome-devtools/` | MCP-based Chrome DevTools: navigate, snapshot, screenshot, console messages, network requests, evaluate JS, emulate, performance trace | **SKILL ONLY** | Skill definition exists, references `chrome-devtools` MCP server. MCP is **not** configured in opencode.json. Cannot confirm MCP tools are callable. |
| `playwright-cli` | `~/.agents/skills/playwright-cli/` + `~/Library/pnpm/bin/playwright-cli` v0.1.14 | Playwright-based: open, goto, click, type, fill, screenshot, snapshot, close | **AVAILABLE** | Installed via pnpm. Alternative/supplement to agent-browser. |
| `npx playwright` | npm registry | Playwright full suite v1.61.1 (installs on first `npx` call) | **AVAILABLE (on-demand)** | Full Playwright available via npx. Heavier than playwright-cli. |
| `agent-reach` | `~/.agents/skills/agent-reach/` | Web content fetching: research, search, fetch URLs from various platforms | **INDIRECT** | For research/info gathering only. Not for page capture or automation. |
| `find-skills` | `~/.agents/skills/find-skills/` | Discover and install additional skills | **INDIRECT** | May help find missing capabilities later. |
| `web-detach` | `.agents/skills/web-detach/` | Project meta-skill: orchestrates web detach workflow | **PROJECT** | This project's own skill. Governs process, doesn't execute capture. |

### Skills Not Relevant to Web Detach

All `cmux-*`, `lark-*`, and `customize-opencode` skills are present but unrelated to web page replication. Omitted from this audit.

---

## Available MCPs

| MCP | Console | Network | DOM | Screenshot | Execute JS | Status |
|---|---|---|---|---|---|---|
| `context7` | N/A | N/A | N/A | N/A | N/A | **CONFIGURED** (docs lookup only, not relevant to web detach) |
| `chrome-devtools` | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | **NOT CONFIGURED** - skill file exists at `~/.agents/skills/chrome-devtools/` but MCP is not registered in `~/.config/opencode/opencode.json` |

**Evidence**: `~/.config/opencode/opencode.json` only configures `context7` MCP. No other MCP entries found. The `chrome-devtools` skill references an MCP server that is not currently connected.

---

## Available CLIs

| Tool | Command | Version | Status | Relevant Capabilities |
|---|---|---|---|---|
| Node.js | `node` | v24.5.0 | Available | Runtime for JS scripts if needed |
| npm | `npm` | 11.5.1 | Available | Package manager |
| pnpm | `pnpm` | 11.5.3 | Available | Package manager (preferred) |
| npx | `npx` | 11.5.1 | Available | Run npm packages without install |
| Python 3 | `python3` | 3.14.6 | Available | Runtime for Python scripts, HTTP server |
| Python | `python` | 3.14.6 (symlink to python3) | Available | Same as python3 |
| curl | `curl` | 8.7.1 | Available | HTTP requests, resource download |
| wget | `wget` | Homebrew | Available | Resource download (alternative to curl) |
| git | `git` | 2.50.1 (Apple Git-155) | Available | Version control |
| agent-browser | `agent-browser` | 0.27.3 | Available | Full browser automation via CDP |
| playwright-cli | `playwright-cli` | 0.1.14 | Available | Playwright browser automation |
| playwright (npx) | `npx playwright` | 1.61.1 | On-demand | Full Playwright suite |
| serve (npx) | `npx serve` | 14.2.6 | On-demand | Static file server |
| PHP | `php` | 8.5.7 | Available | Can serve with `php -S` |

**Evidence**: All version outputs confirmed via `command -v` and `--version` / `--help`. `npx playwright` and `npx serve` confirmed executable (auto-download on first use).

---

## Browser Capability Matrix

Assessment based on `agent-browser` v0.27.3 (CDP), `playwright-cli` v0.1.14, and installed Chrome browser.

| Capability | Status | Preferred Tool | Fallback Tool | Evidence |
|---|---|---|---|---|
| 1. Open specified URL | **AVAILABLE** | `agent-browser open` | `playwright-cli open` | Both CLI tools confirmed functional |
| 2. Get rendered DOM | **AVAILABLE** | `agent-browser snapshot` | `playwright-cli` snapshot | agent-browser provides a11y-tree snapshots; full DOM via `evaluate` |
| 3. View Console | **AVAILABLE** | `agent-browser` (CDP console) | `npx playwright` | agent-browser CDP can capture console; playwright-cli v0.1.14 console support UNKNOWN |
| 4. View Network requests | **PARTIAL** | `agent-browser` (CDP network) | `npx playwright` | agent-browser CDP can monitor network; playwright-cli v0.1.14 network support UNKNOWN |
| 5. Save screenshot | **AVAILABLE** | `agent-browser screenshot` | `playwright-cli screenshot` | Both confirmed |
| 6. Execute page JS | **AVAILABLE** | `agent-browser` (via CDP) | `playwright-cli` (via Playwright) | CDP Runtime.evaluate available |
| 7. Scroll page | **AVAILABLE** | `agent-browser` (key/scroll) | `playwright-cli` scroll | Both support via CDP/Playwright |
| 8. Click/hover elements | **AVAILABLE** | `agent-browser click` | `playwright-cli click` | Both confirmed |
| 9. Save HTML | **AVAILABLE** | `agent-browser` evaluate `document.documentElement.outerHTML` | `curl` + save | Combine JS eval + file write |
| 10. Record API responses | **PARTIAL** | `agent-browser` (CDP Network) | Manual with browser DevTools | CDP can intercept responses; export workflow not automated |
| 11. View local HTTP page | **AVAILABLE** | `agent-browser open http://localhost:PORT` | Any browser | Same as opening any URL |
| 12. Block specific origins | **PARTIAL** | `agent-browser` (CDP Network.setBlockedURLs) | Manual hosts file | CDP supports request blocking; needs explicit command |

**Key observations**:
- `agent-browser` v0.27.3 provides the broadest coverage via CDP
- `playwright-cli` v0.1.14 is a good supplement but has narrower command surface
- Console and Network are `PARTIAL` because the exact CLI workflow for saving/filtering is not yet validated
- Chrome DevTools MCP, if configured, would provide verified Console + Network + DOM capabilities

---

## Local HTTP Server Options

| Option | Status | Command | Advantages | Limitations |
|---|---|---|---|---|
| Python http.server | **AVAILABLE** | `python3 -m http.server 8080` | Zero deps, built-in, supports directory listing | No advanced features, single-threaded |
| PHP built-in server | **AVAILABLE** | `php -S localhost:8080` | Zero deps, built-in, handles PHP files | Overkill for static files |
| npx serve | **ON-DEMAND** | `npx serve -l 8080` | Clean URLs, CORS headers, SPA support | Downloads on first use (~90MB) |
| Node.js (manual) | **SCRIPT-ONLY** | Requires writing a script | Full control | Needs script creation; violates "no premature scripts" rule |

**Recommendation**: `python3 -m http.server` is the preferred choice — zero dependencies, always available. Use `npx serve` only if CORS or SPA routing is needed.

---

## Missing Capabilities

1. **Chrome DevTools MCP**: Skill file present but MCP server not configured. Would provide structured Console + Network + DOM + Screenshot + Performance tools. Currently unavailable.
2. **Automated visual comparison**: No pixel-diff or screenshot comparison tool installed (e.g., `pixelmatch`, `resemble.js`, `backstopjs`). Can be done manually by agent comparing screenshots.
3. **Structured resource discovery**: No automated tool to crawl a page and list all external resources (JS, CSS, images, fonts, API calls). Must be done by combining agent-browser Network monitoring + manual analysis.
4. **Automated resource download pipeline**: No bulk downloader. Must use `curl`/`wget` per resource or write a small script when needed.
5. **Mock API server**: No ready-made mock server (e.g., `json-server`, `msw`). Will need to be set up when the workflow reaches that stage.

---

## Recommended Initial Toolchain

### Preferred Toolchain

- **Page operation**: `agent-browser` (open, navigate, click, type, scroll)
- **DOM reading**: `agent-browser snapshot -i` (interactive elements)
- **Full HTML extraction**: `agent-browser` + evaluate `document.documentElement.outerHTML`
- **Console diagnosis**: `agent-browser` (CDP console messages)
- **Network diagnosis**: `agent-browser` (CDP network monitoring)
- **Screenshot**: `agent-browser screenshot`
- **Resource download**: `curl` / `wget`
- **Local HTTP Server**: `python3 -m http.server`
- **File operations**: Shell (`mkdir`, `cp`, `mv`, `cat`, etc.)

### Fallback Toolchain

- **Page operation**: `playwright-cli` (if agent-browser encounters issues)
- **DOM reading**: `playwright-cli` snapshot
- **Console + Network**: `npx playwright` (full Playwright, heavier but more capable)
- **Local HTTP Server**: `npx serve` (if CORS/SPA needed)

### Currently Missing

- Chrome DevTools MCP (not configured)
- Automated visual diff tooling
- Structured resource discovery pipeline
- Mock API server

---

## Current Decision

*(Historical)* For Phase 1 (capability discovery), the environment was **ready**. `agent-browser` v0.27.3 + Chrome + `curl` + `python3` covered core operations.

---

## Current Project Decision (2026-06-25)

Although `agent-browser` was detected during the original audit and initially used as the preferred tool, the project now **exclusively** uses `playwright-cli` connected to the user's local Google Chrome.

**Rationale**:
- Reduce tool count and eliminate agent confusion between similar tools
- Use the user's real Chrome where pages are already confirmed to render correctly
- Unify all browser operations under a single CLI
- Avoid headless browser detection issues encountered during capture experiments

**Active tools**:
- `playwright-cli` (connect to local Chrome via CDP)
- TypeScript scripts (executed via `tsx`)
- Node.js built-in HTTP server

**No longer used**: agent-browser, Chrome DevTools MCP, Playwright MCP, headless browser modes, other browser automation CLIs.
