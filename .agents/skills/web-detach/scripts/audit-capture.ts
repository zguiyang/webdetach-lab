import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type SiteStats = {
  totalResources?: number;
  remainingExternalUrls?: number;
};

type SiteMeta = {
  sourceUrl?: string;
  status?: string;
  statistics?: SiteStats;
};

type NetworkLog = {
  requests?: unknown[];
};

type ConsoleLog = {
  entries?: unknown[];
};

type Severity = "error" | "warning" | "info";

type Finding = {
  code: string;
  severity: Severity;
  message: string;
  evidence: string[];
  recommendation: string;
};

type AuditReport = {
  siteName: string;
  auditedAt: string;
  summary: {
    remoteScriptTags: number;
    asyncOrDeferScripts: number;
    bodyEndAsyncScripts: number;
    placeholderImages: number;
    networkRequests: number;
    consoleEntries: number;
    remainingExternalUrls: number | null;
  };
  findings: Finding[];
  verdict: "pass" | "warn" | "fail";
};

const VALID_SITE_NAME = /^[a-zA-Z0-9_-]+$/;

function parseArgs(argv: string[]): { siteName: string | null } {
  let siteName: string | null = null;
  for (const arg of argv) {
    if (!arg.startsWith("--") && siteName === null) siteName = arg;
  }
  if (!siteName || !VALID_SITE_NAME.test(siteName)) {
    console.error("Usage: pnpm site:audit-capture -- <site-name>");
    process.exitCode = 1;
  }
  return { siteName };
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function countMatches(input: string, pattern: RegExp): number {
  return [...input.matchAll(pattern)].length;
}

function pushFinding(findings: Finding[], finding: Finding): void {
  findings.push(finding);
}

const { siteName } = parseArgs(process.argv.slice(2));

if (!siteName || process.exitCode) {
  process.exitCode = 1;
} else {
  const projectRoot = process.cwd();
  const siteRoot = join(projectRoot, "sites", siteName);
  const captureRoot = join(siteRoot, "capture");
  const reportsRoot = join(siteRoot, "reports");

  const renderedPath = join(captureRoot, "rendered.html");
  const networkPath = join(captureRoot, "network.json");
  const consolePath = join(captureRoot, "console.json");
  const siteMetaPath = join(siteRoot, "site.json");

  if (!existsSync(renderedPath)) {
    console.error(`rendered.html not found: ${renderedPath}`);
    process.exitCode = 1;
  } else {
    const html = readFileSync(renderedPath, "utf-8");
    const siteMeta = readJsonFile<SiteMeta>(siteMetaPath, {});
    const networkLog = readJsonFile<NetworkLog>(networkPath, {});
    const consoleLog = readJsonFile<ConsoleLog>(consolePath, {});

    const remoteScriptTags = countMatches(
      html,
      /<script\b[^>]*\bsrc="https?:\/\/[^"]+"[^>]*>/gi,
    );
    const asyncOrDeferScripts = countMatches(
      html,
      /<script\b(?=[^>]*\bsrc=)(?=[^>]*\b(?:async|defer)\b)[^>]*>/gi,
    );
    const bodyEndAsyncScripts = countMatches(
      html,
      /<script\b[^>]*\bsrc="https?:\/\/[^"]+"[^>]*\b(?:async|defer)\b[^>]*><\/script>(?:(?!<\/body>).){0,5000}<\/body>/gis,
    );
    const placeholderImages = countMatches(
      html,
      /src="https:\/\/www\.micstatic\.com\/mic-search\/img\/space\.png[^"]*"[^>]*\bdata-(?:src|original)=/gi,
    );
    const networkRequests = Array.isArray(networkLog.requests) ? networkLog.requests.length : 0;
    const consoleEntries = Array.isArray(consoleLog.entries) ? consoleLog.entries.length : 0;
    const remainingExternalUrls =
      typeof siteMeta.statistics?.remainingExternalUrls === "number"
        ? siteMeta.statistics.remainingExternalUrls
        : null;

    const findings: Finding[] = [];

    if (networkRequests === 0 && remoteScriptTags > 0) {
      pushFinding(findings, {
        code: "CAPTURE_SESSION_MISMATCH",
        severity: "error",
        message:
          "rendered.html 含有大量远程脚本，但 capture/network.json 为空，说明导出 HTML 和记录 Network 并非同一浏览器会话。",
        evidence: [
          `remote script tags: ${remoteScriptTags}`,
          `async/defer scripts: ${asyncOrDeferScripts}`,
          `network requests: ${networkRequests}`,
        ],
        recommendation:
          "重新抓取时必须在同一浏览器会话内连续导出 DOM、Network、Console 和截图；不要在 open 结束后再单独补抓日志。",
      });
    }

    if (consoleEntries === 0 && asyncOrDeferScripts > 0) {
      pushFinding(findings, {
        code: "MISSING_CONSOLE_EVIDENCE",
        severity: "warning",
        message:
          "页面包含异步脚本，但 capture/console.json 为空，当前产物不足以证明动态模块是否完整执行。",
        evidence: [
          `async/defer scripts: ${asyncOrDeferScripts}`,
          `console entries: ${consoleEntries}`,
        ],
        recommendation:
          "重新抓取时同步导出 Console；若日志为空，也要确认是页面确实无输出，而不是会话已经丢失。",
      });
    }

    if (bodyEndAsyncScripts > 0) {
      pushFinding(findings, {
        code: "LATE_BODY_SCRIPTS",
        severity: "warning",
        message:
          "页面尾部仍存在晚到的异步脚本，过早导出会导致 sidebar、guide、trade messenger 等区块状态不稳定。",
        evidence: [
          `body-end async/defer scripts: ${bodyEndAsyncScripts}`,
          "examples: index_dcl_14fb8a49.js, nav_c5fc9765.js, pcGuideApp_c79a16db.js",
        ],
        recommendation:
          "捕获前增加稳定条件：至少等待头部导航、侧边栏和首屏推荐区都进入最终可见状态，再导出 rendered.html。",
      });
    }

    if (placeholderImages > 20) {
      pushFinding(findings, {
        code: "LAZY_CONTENT_STILL_PENDING",
        severity: "info",
        message:
          "rendered.html 里仍保留大量 `space.png + data-original/data-src` 懒加载占位，说明页面高度依赖运行时脚本和滚动触发。",
        evidence: [`placeholder images: ${placeholderImages}`],
        recommendation:
          "抓取阶段必须完整滚动页面，并在滚动结束后再次等待懒加载队列稳定，避免首屏之外内容停留在占位状态。",
      });
    }

    if (remainingExternalUrls !== null && remainingExternalUrls > 0) {
      pushFinding(findings, {
        code: "EXTERNAL_DEPENDENCIES_PRESENT",
        severity: "info",
        message: "当前站点仍保留大量外链，后续本地化和断联验证仍需要继续。",
        evidence: [`remainingExternalUrls: ${remainingExternalUrls}`],
        recommendation:
          "先修复捕获稳定性，再进入 CSS、JS、接口和懒加载资源的本地化，否则后续修复会一直建立在漂移基线上。",
      });
    }

    const verdict = findings.some((item) => item.severity === "error")
      ? "fail"
      : findings.some((item) => item.severity === "warning")
        ? "warn"
        : "pass";

    const report: AuditReport = {
      siteName,
      auditedAt: new Date().toISOString(),
      summary: {
        remoteScriptTags,
        asyncOrDeferScripts,
        bodyEndAsyncScripts,
        placeholderImages,
        networkRequests,
        consoleEntries,
        remainingExternalUrls,
      },
      findings,
      verdict,
    };

    mkdirSync(reportsRoot, { recursive: true });
    const reportPath = join(reportsRoot, "capture-audit.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf-8");

    console.log(`Capture audit for ${siteName}`);
    console.log(`Verdict: ${verdict}`);
    console.log(`Report: ${reportPath}`);
    console.log("");
    console.log(`remoteScriptTags: ${remoteScriptTags}`);
    console.log(`asyncOrDeferScripts: ${asyncOrDeferScripts}`);
    console.log(`bodyEndAsyncScripts: ${bodyEndAsyncScripts}`);
    console.log(`placeholderImages: ${placeholderImages}`);
    console.log(`networkRequests: ${networkRequests}`);
    console.log(`consoleEntries: ${consoleEntries}`);
    console.log(`remainingExternalUrls: ${remainingExternalUrls ?? "n/a"}`);

    if (findings.length > 0) {
      console.log("");
      for (const finding of findings) {
        console.log(`[${finding.severity}] ${finding.code}`);
        console.log(`  ${finding.message}`);
      }
    }

    if (verdict === "fail") process.exitCode = 2;
  }
}
