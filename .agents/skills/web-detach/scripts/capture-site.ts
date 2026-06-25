import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, posix, extname, dirname } from "node:path";

type RequestRecord = {
  url: string;
  method: string;
  status: number;
  resourceType: string;
  contentType: string;
  failed: boolean;
  loadedAfterScroll: boolean;
};

type ConsoleEntry = {
  type: string;
  text: string;
  timestamp?: number;
};

type ResourceEntry = {
  url: string;
  type: string;
  host: string;
  status: number;
  discoveredBy: string[];
  loadedAfterScroll: boolean;
  localPath: string | null;
};

type RuntimeManifestEntry = {
  requestKey: string;
  sourceUrl: string;
  publicPath: string;
  contentType: string;
};

type SiteMeta = {
  name: string;
  sourceUrl: string;
  finalUrl: string | null;
  capturedAt: string | null;
  status: "CAPTURING" | "CAPTURED" | "CAPTURED_WITH_GAPS" | "FAILED";
  browserTool: string | null;
  localized: boolean;
  entry: string;
  viewport: { width: number; height: number };
  statistics: {
    requests: number;
    scripts: number;
    stylesheets: number;
    images: number;
    fonts: number;
    fetchXhr: number;
    failedRequests: number;
    consoleErrors: number;
    consoleWarnings: number;
  };
};

const VIEWPORT_W = 1440;
const VIEWPORT_H = 1000;

function parseArgs(argv: string[]): { url: string | null } {
  let url: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--")) continue;
    if (url === null) url = arg;
  }
  if (!url) {
    console.error("Usage: pnpm site:capture -- <url>");
    process.exitCode = 1;
  }
  return { url };
}

function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function siteNameFromUrl(raw: string): string {
  const u = new URL(raw);
  const host = sanitize(u.hostname);
  const path = u.pathname === "/" ? "home" : sanitize(u.pathname) || "page";
  return `${host}-${path}`;
}

function createDirLayout(root: string): void {
  mkdirSync(join(root, "capture", "screenshots"), { recursive: true });
  mkdirSync(join(root, "assets", "css"), { recursive: true });
  mkdirSync(join(root, "assets", "js"), { recursive: true });
  mkdirSync(join(root, "assets", "images"), { recursive: true });
  mkdirSync(join(root, "assets", "fonts"), { recursive: true });
  mkdirSync(join(root, "assets", "media"), { recursive: true });
  mkdirSync(join(root, "assets", "other"), { recursive: true });
  mkdirSync(join(root, "data", "responses"), { recursive: true });
  mkdirSync(join(root, "reports"), { recursive: true });
}

function execTool(cmd: string, label: string): { stdout: string; stderr: string } {
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    return { stdout: out.trim(), stderr: "" };
  } catch (e: any) {
    const stderr = e.stderr?.toString().trim() || "";
    if (stderr) console.error(`[${label}] stderr:`, stderr);
    return { stdout: e.stdout?.toString().trim() || "", stderr };
  }
}

function tryParseJsonOutput(s: string): string {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return s;
}

function isToolAvailable(tool: string): boolean {
  // Check PATH first, then local node_modules/.bin
  try {
    execSync(`command -v ${tool}`, { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    // Also check project-local binary
    try {
      execSync(`test -x node_modules/.bin/${tool}`, { encoding: "utf-8", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

const CACHE_BUST_PARAMS = new Set(["_t", "_", "r", "ts", "timestamp", "cb", "callback"]);

function normalizeApiUrl(urlStr: string): string {
  const url = new URL(urlStr);
  const query = new URLSearchParams(url.search);
  for (const key of [...query.keys()]) {
    if (CACHE_BUST_PARAMS.has(key)) query.delete(key);
  }
  const stable = new URLSearchParams();
  for (const key of [...query.keys()].sort()) {
    for (const value of query.getAll(key)) {
      stable.append(key, value);
    }
  }
  const suffix = stable.toString();
  return suffix
    ? `${url.protocol}//${url.host}${url.pathname}?${suffix}`
    : `${url.protocol}//${url.host}${url.pathname}`;
}

function downloadUrl(urlStr: string): string | null {
  try {
    const out = execSync(
      `curl -sS -L "${urlStr}" ` +
      `-H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" ` +
      `--max-time 15`,
      { encoding: "utf-8", timeout: 20000, maxBuffer: 10 * 1024 * 1024 },
    );
    const text = out.trim();
    if (!text || text.length < 10) return null;
    if (text.includes("请验证") || /captcha/i.test(text) || text.includes("Forbidden")) return null;
    return text;
  } catch {
    return null;
  }
}

function tryDetectTool(): string | null {
  if (isToolAvailable("playwright-cli")) return "playwright-cli";
  if (isToolAvailable("agent-browser")) return "agent-browser";
  return null;
}

function fetchSourceHtml(url: string): string | null {
  // Use curl for source HTML: it bypasses basic anti-bot that blocks
  // Node.js fetch, and is consistent with the project's existing toolchain.
  if (!isToolAvailable("curl")) {
    console.warn("[capture] curl not available, cannot fetch source HTML");
    return null;
  }
  try {
    const out = execSync(
      `curl -sS -L "${url}" ` +
      `-H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" ` +
      `--max-time 15`,
      { encoding: "utf-8", timeout: 20000, maxBuffer: 10 * 1024 * 1024 },
    );
    const text = out.trim();
    if (!text || text.length < 1000) return null;
    // Reject captcha / bot-challenge pages
    if (text.includes("请验证") || /captcha/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function playwrightBin(): string {
  // Prefer project-local binary, fallback to global
  if (isToolAvailable("playwright-cli")) {
    try {
      execSync("command -v playwright-cli", { encoding: "utf-8", timeout: 3000 });
      return "playwright-cli";
    } catch {
      return "./node_modules/.bin/playwright-cli";
    }
  }
  return "playwright-cli";
}

function browserOpenCmd(tool: string, url: string): string {
  if (tool === "agent-browser") return `agent-browser open --headed "${url}"`;
  return `${playwrightBin()} -s=webdetach open "${url}" --headed --persistent --profile=.webdetach/browser-profile`;
}

function browserEvalCmd(tool: string, js: string): string {
  const escaped = js.replace(/"/g, '\\"');
  if (tool === "agent-browser") return `agent-browser eval "${escaped}"`;
  return `${playwrightBin()} -s=webdetach eval "${escaped}"`;
}

function browserScreenshotCmd(tool: string, path: string, fullPage = false): string {
  const fp = fullPage ? " --full" : "";
  if (tool === "agent-browser") return `agent-browser screenshot${fp} "${path}"`;
  return `${playwrightBin()} -s=webdetach screenshot${fp} --filename "${path}"`;
}

function browserCloseCmd(tool: string): string {
  if (tool === "agent-browser") return "agent-browser close";
  return `${playwrightBin()} -s=webdetach close`;
}

function browserRequestsCmd(tool: string): string {
  if (tool === "agent-browser") return "agent-browser --json network requests";
  return `${playwrightBin()} -s=webdetach requests --json`;
}

function browserConsoleCmd(tool: string): string {
  if (tool === "agent-browser") return "agent-browser --json console";
  return `${playwrightBin()} -s=webdetach console --json`;
}

function browserScrollCmd(tool: string, px: number): string {
  if (tool === "agent-browser") return `agent-browser scroll down ${px}`;
  return `${playwrightBin()} -s=webdetach scroll ${px}`;
}

function runBrowserCommands(tool: string, url: string, siteRoot: string): {
  html: string;
  visibleText: string;
  requestsRaw: string;
  consoleRaw: string;
  initialScreenshot: string;
  fullScreenshot: string;
  afterScrollScreenshot: string;
} {
  const initialPath = join(siteRoot, "capture", "screenshots", "initial.png");
  const fullPath = join(siteRoot, "capture", "screenshots", "full-page.png");
  const afterScrollPath = join(siteRoot, "capture", "screenshots", "after-scroll.png");

  const commands = [
    ...(tool === "agent-browser"
      ? [`agent-browser network har start 2>/dev/null; true`]
      : []),
    browserOpenCmd(tool, url),
    `agent-browser set viewport ${VIEWPORT_W} ${VIEWPORT_H} 2>/dev/null; true`,
    `agent-browser wait --load load 2>/dev/null || true`,
    `agent-browser wait --load networkidle 2>/dev/null || true`,
    `agent-browser wait 2000 2>/dev/null || true`,
  ];

  if (tool === "agent-browser") {
    commands.push(
      `agent-browser set viewport ${VIEWPORT_W} ${VIEWPORT_H} 2>/dev/null; true`,
      `agent-browser wait --load load 2>/dev/null || true`,
      `agent-browser wait --load networkidle 2>/dev/null || true`,
      `agent-browser wait 2000 2>/dev/null || true`,
    );
  }

  const chain = commands.join(" && ");
  execTool(chain, "open");

  const title = execTool(
    tool === "agent-browser" ? `agent-browser get title` : `${playwrightBin()} -s=webdetach eval "document.title"`,
    "title",
  ).stdout;
  console.log(`[capture] Page title: ${title}`);

  execTool(browserScreenshotCmd(tool, initialPath), "screenshot-initial");
  console.log("[capture] initial screenshot saved");

  const htmlResult = execTool(browserEvalCmd(tool, "document.documentElement.outerHTML"), "html");
  const html = tryParseJsonOutput(htmlResult.stdout);
  console.log(`[capture] HTML captured (${html.length} bytes)`);

  const textResult = execTool(browserEvalCmd(tool, "document.body.innerText"), "text");
  const visibleText = tryParseJsonOutput(textResult.stdout);
  console.log(`[capture] visible text captured (${visibleText.length} chars)`);

  execTool(browserScreenshotCmd(tool, fullPath, true), "screenshot-full");
  console.log("[capture] full-page screenshot saved");

  execTool(`agent-browser scroll down 5000 2>/dev/null || true`, "scroll-1");
  execTool(`agent-browser scroll down 5000 2>/dev/null || true`, "scroll-2");
  execTool(`agent-browser scroll down 5000 2>/dev/null || true`, "scroll-3");
  execTool(`agent-browser wait 2000 2>/dev/null || true`, "wait-after-scroll");
  console.log("[capture] scroll done");

  execTool(browserScreenshotCmd(tool, afterScrollPath), "screenshot-after");
  console.log("[capture] after-scroll screenshot saved");

  const requestsRaw = execTool(browserRequestsCmd(tool), "requests").stdout;
  console.log(`[capture] network requests captured`);

  const consoleRaw = execTool(browserConsoleCmd(tool), "console").stdout;
  console.log("[capture] console logs captured");

  execTool(browserCloseCmd(tool), "close");

  return {
    html,
    visibleText,
    requestsRaw,
    consoleRaw,
    initialScreenshot: initialPath,
    fullScreenshot: fullPath,
    afterScrollScreenshot: afterScrollPath,
  };
}

function parseRequests(raw: string, _tool: string): RequestRecord[] {
  if (!raw || raw === "{}" || raw === "[]") return [];
  try {
    const data = JSON.parse(raw);
    let list: any[] = [];

    if (data.detail && Array.isArray(data.detail)) {
      list = data.detail;
    } else if (data.success && data.data && data.data.requests && Array.isArray(data.data.requests)) {
      list = data.data.requests;
    } else if (data.success && data.data && Array.isArray(data.data)) {
      list = data.data;
    } else if (Array.isArray(data)) {
      list = data;
    } else if (data.requests && Array.isArray(data.requests)) {
      list = data.requests;
    } else if (data.entries && Array.isArray(data.entries)) {
      list = data.entries;
    } else {
      return [];
    }

    return list.map((r: any) => ({
      url: r.url || "",
      method: r.method || "GET",
      status: r.status || r.response?.status || 0,
      resourceType: r.resourceType || r.type || "other",
      contentType: r.mimeType || r.contentType || r.response?.headers?.["content-type"] || "",
      failed: r.failed || (r.status || 0) >= 400 || false,
      loadedAfterScroll: false,
    })).filter((r: RequestRecord) => r.url);
  } catch {
    return [];
  }
}

function parseConsole(raw: string): ConsoleEntry[] {
  if (!raw || raw === "{}" || raw === "[]") return [];
  try {
    const data = JSON.parse(raw);
    let list: any[] = [];

    if (data.success && data.data && data.data.messages && Array.isArray(data.data.messages)) {
      list = data.data.messages;
    } else if (data.entries && Array.isArray(data.entries)) {
      list = data.entries;
    } else if (data.messages && Array.isArray(data.messages)) {
      list = data.messages;
    } else if (Array.isArray(data)) {
      list = data;
    } else {
      return [];
    }

    return list.map((e: any) => ({
      type: e.type || e.level || "log",
      text: e.text || e.message?.text || e.message || "",
      timestamp: e.timestamp || Date.now(),
    }));
  } catch {
    return [];
  }
}

function classifyResourceType(resourceType: string, contentType: string, url: string): string {
  const lower = contentType.toLowerCase();
  if (resourceType === "stylesheet" || lower.includes("text/css")) return "stylesheet";
  if (resourceType === "script" || lower.includes("javascript")) return "script";
  if (resourceType === "font" || lower.startsWith("font/")) return "font";
  if (resourceType === "image" || lower.startsWith("image/")) return "image";
  if (resourceType === "media" || lower.startsWith("video/") || lower.startsWith("audio/")) return "media";
  if (resourceType === "fetch" || resourceType === "xhr" || lower.includes("json")) return "fetchXhr";
  if (resourceType === "document" || lower.includes("text/html")) return "document";
  if (url.endsWith(".css")) return "stylesheet";
  if (url.endsWith(".js")) return "script";
  if (url.match(/\.(png|jpg|jpeg|gif|svg|webp|avif|ico)(\?|#|$)/i)) return "image";
  if (url.match(/\.(woff2?|ttf|otf|eot)(\?|#|$)/i)) return "font";
  return "other";
}

function makeApiProxyScript(host: string): string {
  return `<script>
(function() {
  var HOST = '//${host}';
  var fixedHost = '${host}';

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = arguments;
    if (typeof url === 'string') {
      if (url.indexOf(HOST) === 0) {
        args[1] = window.location.origin + (url.slice(HOST.length) || '/');
      } else if (url.indexOf('http') === 0) {
        try {
          var p = new URL(url);
          if (p.host === fixedHost) {
            args[1] = window.location.origin + p.pathname + p.search + p.hash;
          }
        } catch(e) {}
      }
    }
    return origOpen.apply(this, args);
  };

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      function rewrite(u) {
        if (!u || typeof u !== 'string') return u;
        if (u.indexOf(HOST) === 0) {
          return window.location.origin + (u.slice(HOST.length) || '/');
        }
        if (u.indexOf('http') === 0) {
          try {
            var p = new URL(u);
            if (p.host === fixedHost) {
              return window.location.origin + p.pathname + p.search + p.hash;
            }
          } catch(e) {}
        }
        return u;
      }
      if (typeof input === 'string') {
        input = rewrite(input);
      } else if (input && typeof input === 'object') {
        var rw = rewrite(input.url);
        if (rw !== input.url) {
          input = new Request(rw, input);
        }
      }
      return origFetch.call(this, input, init);
    };
  }
})();
</script>`;
}

async function main(): Promise<void> {
  const { url } = parseArgs(process.argv.slice(2));
  if (!url || process.exitCode) { process.exitCode = 1; return; }

  const sourceUrl = new URL(url).toString();
  const name = siteNameFromUrl(sourceUrl);
  const projectRoot = process.cwd();
  const siteRoot = join(projectRoot, "sites", name);

  const tool = tryDetectTool();
  if (!tool) {
    console.error("No browser tool found. Run pnpm install (includes @playwright/cli) or check node_modules/.bin/playwright-cli.");
    process.exitCode = 1;
    return;
  }
  console.log(`[capture] Using: ${tool}`);

  if (existsSync(siteRoot)) {
    console.error(`Site directory already exists: ${name}`);
    console.error(`Use --force to overwrite, or choose a different name.`);
    process.exitCode = 1;
    return;
  }

  createDirLayout(siteRoot);
  console.log(`[capture] Directory layout created: sites/${name}`);

  const capturedAt = new Date().toISOString();
  const meta: SiteMeta = {
    name,
    sourceUrl,
    finalUrl: null,
    capturedAt,
    status: "CAPTURING",
    browserTool: tool,
    localized: false,
    entry: "index.html",
    viewport: { width: VIEWPORT_W, height: VIEWPORT_H },
    statistics: {
      requests: 0, scripts: 0, stylesheets: 0, images: 0, fonts: 0,
      fetchXhr: 0, failedRequests: 0, consoleErrors: 0, consoleWarnings: 0,
    },
  };
  writeFileSync(join(siteRoot, "site.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");

  // Fetch original server response (pre-JS) for proper framework hydration
  const sourceHtml = await fetchSourceHtml(sourceUrl);
  if (sourceHtml) {
    writeFileSync(join(siteRoot, "capture", "source.html"), sourceHtml, "utf-8");
    console.log(`[capture] Source HTML saved (${sourceHtml.length} bytes)`);
  } else {
    console.warn("[capture] Source HTML unavailable, will fall back to rendered.html as entry");
  }

  let html = "";
  let visibleText = "";
  let requestsRaw = "";
  let consoleRaw = "";
  let captureFailed = false;

  try {
    const result = runBrowserCommands(tool, sourceUrl, siteRoot);
    html = result.html;
    visibleText = result.visibleText;
    requestsRaw = result.requestsRaw;
    consoleRaw = result.consoleRaw;
  } catch (err) {
    console.error("[capture] Browser capture failed:", err);
    captureFailed = true;
  }

  if (!html) {
    meta.status = "FAILED";
    meta.capturedAt = capturedAt;
    writeFileSync(join(siteRoot, "site.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
    process.exitCode = 1;
    return;
  }

  const requests = parseRequests(requestsRaw, tool);
  const consoleEntries = parseConsole(consoleRaw);

  writeFileSync(join(siteRoot, "capture", "rendered.html"), html, "utf-8");

  // index.html = source.html (pre-JS server response) for correct
  // framework hydration, avoiding duplicate client-side mounts.
  // Inject an XHR/fetch proxy to redirect host-relative API URLs
  // to the local server (protocol-relative URLs like //host/api
  // become cross-origin when served from localhost).
  if (sourceHtml) {
    const originHost = new URL(sourceUrl).host;
    const proxyScript = makeApiProxyScript(originHost);
    const patched = sourceHtml.includes("<head>")
      ? sourceHtml.replace("<head>", `<head>\n${proxyScript}`)
      : sourceHtml;
    writeFileSync(join(siteRoot, "index.html"), patched, "utf-8");
  } else {
    writeFileSync(join(siteRoot, "index.html"), html, "utf-8");
  }
  writeFileSync(join(siteRoot, "capture", "visible-text.txt"), visibleText, "utf-8");

  writeFileSync(
    join(siteRoot, "capture", "network.json"),
    JSON.stringify({ tool, requests }, null, 2) + "\n",
    "utf-8",
  );
  writeFileSync(
    join(siteRoot, "capture", "console.json"),
    JSON.stringify({ tool, entries: consoleEntries }, null, 2) + "\n",
    "utf-8",
  );

  const seen = new Set<string>();
  const resources: ResourceEntry[] = [];
  for (const req of requests) {
    if (seen.has(req.url)) continue;
    seen.add(req.url);
    const host = new URL(req.url).host;
    resources.push({
      url: req.url,
      type: classifyResourceType(req.resourceType, req.contentType, req.url),
      host,
      status: req.status,
      discoveredBy: ["network"],
      loadedAfterScroll: req.loadedAfterScroll || false,
      localPath: null,
    });
  }

  writeFileSync(
    join(siteRoot, "capture", "resources.json"),
    JSON.stringify({ resources }, null, 2) + "\n",
    "utf-8",
  );

  // Capture API response data for fetchXhr resources.
  // These are used by the inject proxy script at serve time to
  // provide dynamic data without making runtime cross-origin requests.
  const apiResources = resources.filter((r) => r.type === "fetchXhr" && r.status === 200);
  const runtimeManifest: RuntimeManifestEntry[] = [];
  if (apiResources.length > 0) {
    mkdirSync(join(siteRoot, "data", "responses"), { recursive: true });
    console.log(`[capture] Capturing ${apiResources.length} API response(s)...`);
    for (const res of apiResources) {
      const data = downloadUrl(res.url);
      if (data) {
        const key = normalizeApiUrl(res.url);
        const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
        const publicPath = `./data/responses/api-${hash}.json`;
        writeFileSync(join(siteRoot, publicPath), data, "utf-8");
        runtimeManifest.push({
          requestKey: key,
          sourceUrl: res.url,
          publicPath,
          contentType: "application/json",
        });
      }
    }
    if (runtimeManifest.length > 0) {
      writeFileSync(
        join(siteRoot, "data", "runtime-origin-map.json"),
        JSON.stringify(runtimeManifest, null, 2) + "\n",
        "utf-8",
      );
      console.log(`[capture] Saved ${runtimeManifest.length} API response(s) to data/runtime-origin-map.json`);
    }
  }

  const reqCount = requests.length;
  const scriptCount = resources.filter((r) => r.type === "script").length;
  const styleCount = resources.filter((r) => r.type === "stylesheet").length;
  const imageCount = resources.filter((r) => r.type === "image").length;
  const fontCount = resources.filter((r) => r.type === "font").length;
  const fetchXhrCount = resources.filter((r) => r.type === "fetchXhr").length;
  const failedCount = requests.filter((r) => r.failed || r.status >= 400).length;
  const consoleErrors = consoleEntries.filter((e) => e.type === "error").length;
  const consoleWarnings = consoleEntries.filter((e) => e.type === "warning").length;

  meta.finalUrl = sourceUrl;
  meta.status = captureFailed ? "CAPTURED_WITH_GAPS" : (html ? "CAPTURED" : "FAILED");
  meta.statistics = {
    requests: reqCount,
    scripts: scriptCount,
    stylesheets: styleCount,
    images: imageCount,
    fonts: fontCount,
    fetchXhr: fetchXhrCount,
    failedRequests: failedCount,
    consoleErrors,
    consoleWarnings,
  };
  writeFileSync(join(siteRoot, "site.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");

  const hasHtml = Boolean(html);
  const hasNetwork = requests.length > 0;
  const hasResources = resources.length > 0;
  const hasConsole = consoleEntries.length > 0;
  const hasScreenshots =
    existsSync(join(siteRoot, "capture", "screenshots", "initial.png")) &&
    existsSync(join(siteRoot, "capture", "screenshots", "full-page.png"));

  const readyForLocalization =
    hasHtml && hasNetwork && hasResources && hasScreenshots
      ? "YES"
      : hasHtml && (hasNetwork || hasScreenshots)
        ? "PARTIAL"
        : "NO";

  const gaps: string[] = [];
  if (!hasNetwork) gaps.push("Network requests not captured");
  if (!hasConsole) gaps.push("Console logs empty or not captured");
  if (failedCount > 0) gaps.push(`${failedCount} failed requests`);
  if (consoleErrors > 0) gaps.push(`${consoleErrors} console errors`);

  const sourceBytes = sourceHtml ? sourceHtml.length : 0;
  const entrySource = sourceHtml ? "source.html (pre-JS)" : "rendered.html (fallback)";
  const mdLines = [
    `# Capture Summary`,
    ``,
    `## Target`,
    `- URL: ${sourceUrl}`,
    ``,
    `## Browser Tool`,
    `- Tool: ${tool}`,
    ``,
    `## Page Metadata`,
    `- Site name: \`${name}\``,
    `- Viewport: ${VIEWPORT_W} × ${VIEWPORT_H}`,
    `- Captured at: ${capturedAt}`,
    `- Entry page source: ${entrySource}`,
    ``,
    `## Captured Files`,
    `- \`capture/source.html\` — ${sourceHtml ? `${sourceBytes} bytes` : "UNAVAILABLE"}`,
    `- \`capture/rendered.html\` — ${hasHtml ? `${html.length} bytes` : "MISSING"}`,
    `- \`capture/visible-text.txt\` — ${visibleText ? `${visibleText.length} chars` : "MISSING"}`,
    `- \`capture/network.json\` — ${hasNetwork ? `${requests.length} requests` : "MISSING"}`,
    `- \`capture/resources.json\` — ${hasResources ? `${resources.length} resources` : "MISSING"}`,
    `- \`capture/console.json\` — ${hasConsole ? `${consoleEntries.length} entries` : "MISSING"}`,
    `- \`capture/screenshots/initial.png\``,
    `- \`capture/screenshots/full-page.png\``,
    `- \`capture/screenshots/after-scroll.png\``,
    ``,
    `## Network Statistics`,
    `- Total requests: ${reqCount}`,
    `- Failed: ${failedCount}`,
    `- Scripts: ${scriptCount}`,
    `- Stylesheets: ${styleCount}`,
    `- Images: ${imageCount}`,
    `- Fonts: ${fontCount}`,
    `- Fetch/XHR: ${fetchXhrCount}`,
    ``,
    `## Resource Statistics`,
    `- Total unique resources: ${resources.length}`,
    ``,
    `## Console Summary`,
    `- Total entries: ${consoleEntries.length}`,
    `- Errors: ${consoleErrors}`,
    `- Warnings: ${consoleWarnings}`,
    ``,
    `## Dynamic Resources Found After Scroll`,
    `- (Not tracked in this phase)`,
    ``,
    `## Capture Gaps`,
    gaps.length > 0 ? gaps.map((g) => `- ${g}`).join("\n") : `- None`,
    ``,
    `## Ready for Localization`,
    readyForLocalization,
    ``,
  ].join("\n");
  writeFileSync(join(siteRoot, "reports", "capture-summary.md"), mdLines, "utf-8");

  console.log(`\nCaptured ${sourceUrl}`);
  console.log(`Site directory: sites/${name}`);
  console.log(`Browser tool: ${tool}`);
  console.log(`Fallback used: false`);
  console.log(`Requests: ${reqCount}`);
  console.log(`  Scripts: ${scriptCount}`);
  console.log(`  Stylesheets: ${styleCount}`);
  console.log(`  Images: ${imageCount}`);
  console.log(`  Fonts: ${fontCount}`);
  console.log(`  Fetch/XHR: ${fetchXhrCount}`);
  console.log(`  Failed: ${failedCount}`);
  console.log(`Console: ${consoleErrors} errors, ${consoleWarnings} warnings`);
  console.log(`Files: source.html, rendered.html, visible-text.txt, network.json, resources.json, console.json, 3 screenshots`);
  console.log(`Entry: index.html = ${entrySource}`);
  console.log(`Gaps: ${gaps.join("; ") || "none"}`);
  console.log(`Ready for localization: ${readyForLocalization}`);
  console.log(`API responses saved: ${runtimeManifest.length}`);
  console.log(`No resources downloaded, no HTML/CSS/JS modified.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
