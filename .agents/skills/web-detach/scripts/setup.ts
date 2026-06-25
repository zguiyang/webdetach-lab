import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "WARN";
  message: string;
  fix?: string;
}

function exec(cmd: string, timeout = 10000): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout, stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function checkNodeVersion(): CheckResult {
  const v = process.version;
  const major = process.versions.node.split(".")[0];
  if (major === "22" || major === "24") {
    return { name: "Node.js", status: "PASS", message: `${v} ✓` };
  }
  return {
    name: "Node.js", status: "FAIL", message: `${v}，需要 v22.x 或 v24.x`,
    fix: "安装 Node.js LTS: https://nodejs.org",
  };
}

function checkPnpm(): CheckResult {
  const v = exec("pnpm --version");
  if (v) {
    return { name: "pnpm", status: "PASS", message: `v${v} ✓` };
  }
  return {
    name: "pnpm", status: "FAIL", message: "未安装",
    fix: "npm install -g pnpm 或 brew install pnpm",
  };
}

function checkProjectDeps(): CheckResult {
  const required = ["typescript", "tsx", "@types/node", "parse5", "@playwright/cli"];
  const missing: string[] = [];
  for (const pkg of required) {
    const p = join(PROJECT_ROOT, "node_modules", pkg);
    if (!existsSync(p)) missing.push(pkg);
  }
  if (missing.length === 0) {
    return { name: "项目依赖", status: "PASS", message: `${required.length}/5 ✓` };
  }
  return {
    name: "项目依赖", status: "FAIL", message: `缺失: ${missing.join(", ")}`,
    fix: "pnpm install",
  };
}

function checkPlaywrightCli(): CheckResult {
  // Check local node_modules binary first
  const localBin = join(PROJECT_ROOT, "node_modules", ".bin", "playwright-cli");
  if (existsSync(localBin)) {
    const v = exec(`${localBin} --version 2>/dev/null`);
    return { name: "playwright-cli", status: "PASS", message: `v${v || "?"} ✓` };
  }
  // Fallback: global
  const v = exec("playwright-cli --version 2>/dev/null");
  if (v) {
    return { name: "playwright-cli", status: "WARN", message: `v${v} (全局安装，推荐改为项目依赖后重装)` };
  }
  return {
    name: "playwright-cli", status: "FAIL", message: "未安装",
    fix: "pnpm install（已配置为项目依赖）",
  };
}

function checkChrome(): CheckResult {
  const paths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return { name: "Google Chrome", status: "PASS", message: `✓` };
    }
  }
  const which = exec("which google-chrome google-chrome-stable chromium-browser 2>/dev/null");
  if (which) {
    return { name: "Google Chrome", status: "PASS", message: `${which} ✓` };
  }
  return {
    name: "Google Chrome", status: "FAIL", message: "未安装",
    fix: "macOS: brew install --cask google-chrome",
  };
}

function checkFileSystem(): CheckResult {
  const sitesDir = join(PROJECT_ROOT, "sites");
  if (!existsSync(sitesDir)) {
    return { name: "sites/ 目录", status: "FAIL", message: "不存在", fix: "mkdir sites" };
  }
  try {
    const testFile = join(sitesDir, ".setup-test");
    execSync(`touch "${testFile}" && rm "${testFile}"`);
    return { name: "sites/ 目录", status: "PASS", message: `可读写 ✓` };
  } catch {
    return { name: "sites/ 目录", status: "FAIL", message: "不可写", fix: "chmod +w sites" };
  }
}

function checkCurl(): CheckResult {
  const v = exec("curl --version 2>/dev/null");
  if (v) {
    return { name: "curl", status: "PASS", message: `✓` };
  }
  return { name: "curl", status: "WARN", message: "未安装（捕获阶段需要）", fix: "brew install curl" };
}

const checks: (() => CheckResult)[] = [
  checkNodeVersion,
  checkPnpm,
  checkProjectDeps,
  checkPlaywrightCli,
  checkChrome,
  checkFileSystem,
  checkCurl,
];

function formatBlocked(): string {
  return [
    "",
    `${BOLD}${RED}═══ 环境检查未通过 ═══${RESET}`,
    `${YELLOW}请修复上述 FAIL 项后重新运行 pnpm setup。${RESET}`,
    `${YELLOW}缺少 Node.js 或 pnpm 时，即使 pnpm setup 也无法运行，需要手动安装。${RESET}`,
    "",
  ].join("\n");
}

function formatPassed(): string {
  return [
    "",
    `${BOLD}${GREEN}═══ 全部通过，可以开始复刻 ═══${RESET}`,
    `${BOLD}pnpm site:capture -- <url>${RESET}  — 捕获一个网页`,
    `${BOLD}pnpm site:serve -- <site-name>${RESET}   — 本地预览`,
    `${BOLD}pnpm typecheck${RESET}                     — 类型检查`,
    "",
  ].join("\n");
}

function formatWarnBlocked(warnBlocked: boolean): string {
  return warnBlocked
    ? `${YELLOW}存在未通过项（FAIL），请修复后重试。\nWARN 项不阻塞，但可能影响部分功能。${RESET}`
    : "";
}

function main(): void {
  const results = checks.map((fn) => fn());
  const hasFail = results.some((r) => r.status === "FAIL");
  const hasWarn = results.some((r) => r.status === "WARN");

  // ── render ──────────────────────────────────────────────────────────
  const lines = results.map((r) => {
    const icon = r.status === "PASS" ? `${GREEN}●${RESET}`
      : r.status === "FAIL" ? `${RED}●${RESET}`
        : `${YELLOW}●${RESET}`;
    const fix = r.fix ? `  ${YELLOW}→ ${r.fix}${RESET}` : "";
    return `  ${icon} ${r.name}: ${r.message}${fix}`;
  });

  console.log(`\n${BOLD}webdetach-lab 环境检查${RESET}\n`);
  console.log(lines.join("\n"));

  if (hasFail) {
    console.log(formatBlocked());
    process.exitCode = 1;
  } else {
    console.log(formatPassed());
    if (hasWarn) console.log(formatWarnBlocked(false));
  }
}

main();
