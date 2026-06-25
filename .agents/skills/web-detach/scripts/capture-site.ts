import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, extname, dirname, posix } from "node:path";
import { homedir } from "node:os";
import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";

type ConsoleEntry = {
  type: string;
  text: string;
  location?: string;
};

type ScreenProbe = {
  availWidth: number;
  availHeight: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
};

type CaptureSummary = {
  stableChecks: {
    headerReady: boolean;
    primaryCategoriesReady: boolean;
    sidebarReady: boolean;
  };
  screenProbe: ScreenProbe;
  launchWindow: {
    width: number;
    height: number;
  };
  finalViewport: {
    innerWidth: number;
    innerHeight: number;
  };
  calibratedViewport: {
    innerWidth: number;
    innerHeight: number;
  };
  requestCount: number;
  consoleCount: number;
  mirroredResources: number;
  mockedResponses: number;
};

type SiteMeta = {
  name: string;
  sourceUrl: string;
  finalUrl: string;
  capturedAt: string;
  status: "CAPTURING" | "CAPTURED" | "CAPTURED_WITH_GAPS" | "FAILED";
  browserTool: string;
  localized: boolean;
  entry: string;
  viewport: {
    width: number;
    height: number;
  };
  updatedAt: string;
  statistics: {
    totalResources: number;
    remainingExternalUrls: number;
    consoleEntries: number;
    requests: number;
  };
};

type Classification =
  | "asset-static"
  | "script-dynamic"
  | "style-dynamic"
  | "data-display"
  | "data-user"
  | "tracking"
  | "polling"
  | "security"
  | "ignore";

type ResourceKind = "html" | "css" | "js" | "font" | "image" | "media" | "data" | "other";

type ResourceEntry = {
  id: number;
  url: string;
  method: string;
  resourceType: string;
  status: number | null;
  failed: boolean;
  failureText?: string;
  contentType?: string;
  contentLength?: number;
  classification: Classification;
  include: boolean;
  kind: ResourceKind;
  localPath?: string;
  requestKey?: string;
  responseBodyPath?: string;
};

type DynamicAssetRecord = {
  tag: string;
  url: string;
  rel?: string | null;
  textLength?: number;
};

type Patch = {
  offset: number;
  length: number;
  replacement: string;
};

type AttrRef = {
  tagName: string;
  attrName: string;
  originalValue: string;
  offsets: { start: number; end: number };
};

type DocumentNode = DefaultTreeAdapterMap["document"];
type ElementNode = DefaultTreeAdapterMap["element"];
type TreeNode = DefaultTreeAdapterMap["node"];

const DEFAULT_BOOTSTRAP_WIDTH = 1280;
const DEFAULT_BOOTSTRAP_HEIGHT = 900;
const PROFILE_DIR = ".webdetach/browser-profile-capture";
const PLAYWRIGHT_CORE_CANDIDATES = [
  join(
    homedir(),
    "Library/pnpm/store/v11/links/@/playwright-core/1.61.0-alpha-1781023400000/cdd2b948fab08debdcaedd2c18a561a404e8416643a25d913c2f7f6f81704452/node_modules/playwright-core/index.mjs",
  ),
];
const HTML_ATTRS = new Set([
  "src",
  "href",
  "poster",
  "data-src",
  "data-srcset",
  "data-original",
  "data-lazy-src",
  "srcset",
  "xlink:href",
]);
const TRACKING_PATTERNS = [
  "analytics",
  "beacon",
  "clarity",
  "gtm",
  "google-analytics",
  "sensors",
  "tingyun",
  "probe",
  "sa?",
  "/rum",
];
const USER_PATTERNS = [
  "login",
  "sign-in",
  "signin",
  "message",
  "inbox",
  "favorite",
  "membercenter",
  "token",
  "cart",
  "basket",
  "unread",
  "profile",
  "visitorId",
];
const POLLING_PATTERNS = ["polling", "heartbeat", "keepalive", "longpoll"];
const SECURITY_PATTERNS = ["captcha", "risk", "anti", "shield", "secure"];

function parseArgs(argv: string[]): { url: string | null; force: boolean } {
  let url: string | null = null;
  let force = false;
  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (!arg.startsWith("--") && url === null) {
      url = arg;
    }
  }
  if (!url) {
    console.error("Usage: pnpm site:capture -- <url> [--force]");
    process.exitCode = 1;
  }
  return { url, force };
}

function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function siteNameFromUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const host = sanitizeSegment(url.hostname);
  const path = url.pathname === "/" ? "home" : sanitizeSegment(url.pathname) || "page";
  return `${host}-${path}`;
}

function ensureCleanDir(dir: string, force: boolean): void {
  if (force) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function createSiteLayout(siteRoot: string): void {
  mkdirSync(join(siteRoot, "capture", "screenshots"), { recursive: true });
  mkdirSync(join(siteRoot, "assets", "mirror"), { recursive: true });
  mkdirSync(join(siteRoot, "data", "responses"), { recursive: true });
  mkdirSync(join(siteRoot, "reports"), { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function sha(text: string, len = 10): string {
  return createHash("sha1").update(text).digest("hex").slice(0, len);
}

function sanitizeFileSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extFromContentType(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("text/css")) return ".css";
  if (lower.includes("javascript")) return ".js";
  if (lower.includes("application/json")) return ".json";
  if (lower.includes("text/html")) return ".html";
  if (lower.includes("image/svg+xml")) return ".svg";
  if (lower.includes("image/png")) return ".png";
  if (lower.includes("image/jpeg")) return ".jpg";
  if (lower.includes("image/webp")) return ".webp";
  if (lower.includes("image/gif")) return ".gif";
  if (lower.includes("font/woff2")) return ".woff2";
  if (lower.includes("font/woff")) return ".woff";
  if (lower.includes("font/ttf")) return ".ttf";
  if (lower.includes("font/otf")) return ".otf";
  if (lower.includes("video/mp4")) return ".mp4";
  if (lower.includes("audio/")) return ".mp3";
  if (lower.includes("text/plain")) return ".txt";
  return ".bin";
}

function buildMirrorPaths(siteRoot: string, rawUrl: string, contentType = ""): { publicPath: string; diskPath: string } {
  const url = new URL(rawUrl);
  const protocol = url.protocol.replace(":", "");
  const segments = url.pathname.split("/").filter(Boolean).map(sanitizeFileSegment);
  let filename = segments.pop() ?? "index";
  const ext = extname(filename) || extFromContentType(contentType);
  if (!extname(filename)) filename += ext;
  if (url.search) {
    const currentExt = extname(filename);
    const base = currentExt ? filename.slice(0, -currentExt.length) : filename;
    filename = `${base}__${sha(url.search)}${currentExt || ext}`;
  }
  const relPath = posix.join("assets", "mirror", protocol, url.host, ...segments, filename);
  return {
    publicPath: `/${relPath}`,
    diskPath: join(siteRoot, relPath),
  };
}

function buildResponsePaths(siteRoot: string, rawUrl: string, contentType = ""): { publicPath: string; diskPath: string } {
  const relPath = posix.join("data", "responses", `${sha(rawUrl, 16)}${extFromContentType(contentType)}`);
  return {
    publicPath: `/${relPath}`,
    diskPath: join(siteRoot, relPath),
  };
}

function normalizeRequestKey(rawUrl: string): string {
  const url = new URL(rawUrl);
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) {
    if (["_", "_t", "r", "ts", "timestamp", "cb", "callback"].includes(key)) {
      params.delete(key);
    }
  }
  const stable = new URLSearchParams();
  for (const key of [...params.keys()].sort()) {
    for (const value of params.getAll(key)) {
      stable.append(key, value);
    }
  }
  const suffix = stable.toString();
  return suffix ? `${url.origin}${url.pathname}?${suffix}` : `${url.origin}${url.pathname}`;
}

function detectKind(resourceType: string, contentType: string, url: string): ResourceKind {
  const lower = contentType.toLowerCase();
  if (resourceType === "stylesheet" || lower.includes("text/css")) return "css";
  if (resourceType === "script" || lower.includes("javascript")) return "js";
  if (resourceType === "font" || lower.startsWith("font/")) return "font";
  if (resourceType === "image" || lower.startsWith("image/")) return "image";
  if (resourceType === "media" || lower.startsWith("video/") || lower.startsWith("audio/")) return "media";
  if (resourceType === "document" || lower.includes("text/html")) return "html";
  if (resourceType === "fetch" || resourceType === "xhr" || lower.includes("json") || lower.includes("text/plain")) {
    return "data";
  }
  if (url.endsWith(".css")) return "css";
  if (url.endsWith(".js")) return "js";
  return "other";
}

function classifyResource(url: string, method: string, resourceType: string, contentType: string): Classification {
  const lowerUrl = url.toLowerCase();
  if (method.toUpperCase() !== "GET") return "ignore";
  if (TRACKING_PATTERNS.some((token) => lowerUrl.includes(token))) return "tracking";
  if (SECURITY_PATTERNS.some((token) => lowerUrl.includes(token))) return "security";
  if (POLLING_PATTERNS.some((token) => lowerUrl.includes(token))) return "polling";
  if (USER_PATTERNS.some((token) => lowerUrl.includes(token))) return "data-user";

  if (resourceType === "fetch" || resourceType === "xhr") return "data-display";
  if (resourceType === "script") return "script-dynamic";
  if (resourceType === "stylesheet") return "style-dynamic";
  if (["image", "font", "media", "document"].includes(resourceType)) return "asset-static";

  if (contentType.includes("text/css")) return "style-dynamic";
  if (contentType.includes("javascript")) return "script-dynamic";
  if (contentType.startsWith("image/") || contentType.startsWith("font/")) return "asset-static";

  return "asset-static";
}

function shouldInclude(classification: Classification): boolean {
  return ["asset-static", "script-dynamic", "style-dynamic", "data-display"].includes(classification);
}

async function readResponseBodyWithTimeout(response: any, timeoutMs: number): Promise<Buffer | null> {
  const bodyPromise = response.body().then((value: Buffer) => Buffer.from(value));
  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeoutMs);
  });
  return await Promise.race([bodyPromise, timeoutPromise]);
}

async function loadPlaywright(): Promise<any> {
  for (const candidate of PLAYWRIGHT_CORE_CANDIDATES) {
    try {
      return await import(candidate);
    } catch {
      continue;
    }
  }
  throw new Error("Unable to import playwright-core from the known global installation path.");
}

async function readViewportProbe(page: any): Promise<ScreenProbe> {
  return (await page.evaluate(() => {
    const g = globalThis as any;
    return {
      availWidth: g.screen.availWidth,
      availHeight: g.screen.availHeight,
      outerWidth: g.outerWidth,
      outerHeight: g.outerHeight,
      innerWidth: g.innerWidth,
      innerHeight: g.innerHeight,
      devicePixelRatio: g.devicePixelRatio,
    };
  })) as ScreenProbe;
}

async function waitForStableHome(page: any): Promise<CaptureSummary["stableChecks"]> {
  const result = await page.waitForFunction(
    () => {
      const g = globalThis as any;
      const doc = g.document as {
        querySelector(selector: string): unknown | null;
        querySelectorAll(selector: string): ArrayLike<{ textContent?: string | null; src?: string }>;
      };
      const headerReady = Boolean(
        doc.querySelector("#header .nail-search-input") &&
          doc.querySelector("#header .nail-business"),
      );

      const pcCategories = Array.from(
        doc.querySelectorAll(".J-cate-in-pc .J-first-cate-name"),
      ).filter((node) => (node.textContent || "").trim().length > 0).length;
      const pcCategoriesReady = pcCategories >= 20;

      const sidebarReady = Boolean(
        doc.querySelector("#SideBar .side-bar-item") ||
          doc.querySelector("#webtm-wrapper .webtm-min-task"),
      );

      const mainContentReady = Boolean(
        doc.querySelector(".section-block.home-top") ||
          doc.querySelector(".campaign-main-wrap"),
      );

      const hasRealImages = Array.from(
        doc.querySelectorAll("img[src]"),
      ).filter((img) => {
        const src = (img as any).src || "";
        return src && !src.includes("space.png") && !src.includes("blank.gif") && !src.includes("data:image/svg+xml");
      }).length >= 5;

      return {
        headerReady,
        primaryCategoriesReady: pcCategoriesReady,
        sidebarReady,
        mainContentReady,
        hasRealImages,
        done: headerReady && pcCategoriesReady && mainContentReady && hasRealImages,
      };
    },
    { timeout: 60000, polling: 500 },
  );
  const value = await result.jsonValue();
  return {
    headerReady: Boolean(value.headerReady),
    primaryCategoriesReady: Boolean(value.primaryCategoriesReady),
    sidebarReady: Boolean(value.sidebarReady),
  };
}

async function triggerSafeInteractions(page: any): Promise<void> {
  const selectors = [
    "#header .nail-categories .cate-entrance",
    "#header .nail-supplier .nail-entrance",
    "#header .nail-buyer .nail-entrance",
    "#header .nail-help .nail-entrance",
    "#header .nail-language .nail-entrance",
  ];
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (!handle) continue;
    await handle.hover({ timeout: 1000 }).catch(() => undefined);
    await page.waitForTimeout(250);
  }
}

function installDynamicAssetProbeScript(): string {
  return `
    (() => {
      const records = [];
      const push = (node) => {
        if (!node || node.nodeType !== 1) return;
        const tag = node.tagName ? node.tagName.toLowerCase() : "";
        if (!["script", "link", "style"].includes(tag)) return;
        const url = tag === "script" ? node.src : node.href;
        records.push({
          tag,
          url: url || "",
          rel: node.rel || null,
          textLength: (node.textContent || "").length
        });
      };
      window.__wdDynamicAssets = records;
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => push(node));
        }
      });
      const start = () => observer.observe(document.documentElement, { childList: true, subtree: true });
      if (document.documentElement) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });
    })();
  `;
}

function walkNodes(node: TreeNode, callback: (el: ElementNode) => void): void {
  if ("tagName" in node && node.tagName) callback(node as ElementNode);
  if ("childNodes" in node && node.childNodes) {
    for (const child of (node as { childNodes: TreeNode[] }).childNodes) walkNodes(child, callback);
  }
}

function resolveAttrValueOffsets(html: string, startOffset: number, endOffset: number, originalValue: string): { start: number; end: number } | null {
  const raw = html.slice(startOffset, endOffset);
  const eqIndex = raw.indexOf("=");
  if (eqIndex === -1) return null;
  const valueArea = raw.slice(eqIndex + 1).trimStart();
  const valueOffset = raw.indexOf(valueArea, eqIndex + 1);
  if (valueOffset === -1) return null;
  const firstChar = valueArea[0];
  if (firstChar === `"` || firstChar === `'`) {
    const closingIndex = valueArea.indexOf(firstChar, 1);
    if (closingIndex === -1) return null;
    return {
      start: startOffset + valueOffset + 1,
      end: startOffset + valueOffset + closingIndex,
    };
  }
  const valueIndex = raw.indexOf(originalValue, eqIndex + 1);
  if (valueIndex === -1) return null;
  return {
    start: startOffset + valueIndex,
    end: startOffset + valueIndex + originalValue.length,
  };
}

function extractHtmlRefs(html: string): AttrRef[] {
  const doc = parse(html, { sourceCodeLocationInfo: true }) as DocumentNode;
  const refs: AttrRef[] = [];
  walkNodes(doc, (el) => {
    for (const attr of el.attrs) {
      if (!HTML_ATTRS.has(attr.name)) continue;
      const loc = el.sourceCodeLocation?.attrs?.[attr.name];
      if (!loc) continue;
      const offsets = resolveAttrValueOffsets(html, loc.startOffset, loc.endOffset, attr.value);
      if (!offsets) continue;
      refs.push({
        tagName: el.tagName,
        attrName: attr.name,
        originalValue: attr.value,
        offsets,
      });
    }
  });
  return refs;
}

function resolveUrl(raw: string, base: string): string | null {
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("javascript:")) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function shouldRewriteHtmlAttr(ref: AttrRef): boolean {
  const tag = ref.tagName.toLowerCase();
  const attr = ref.attrName.toLowerCase();
  if (attr === "srcset" || attr === "data-srcset") {
    return ["img", "source"].includes(tag);
  }
  if (["script", "img", "source", "video", "audio", "iframe", "embed"].includes(tag)) {
    return ["src", "poster", "data-src", "data-original", "data-lazy-src", "xlink:href"].includes(attr);
  }
  if (tag === "link") {
    return attr === "href";
  }
  return false;
}

function rewriteHtml(renderedHtml: string, sourceUrl: string, replacementMap: Map<string, string>): string {
  const refs = extractHtmlRefs(renderedHtml);
  const patches: Patch[] = [];
  for (const ref of refs) {
    if (!shouldRewriteHtmlAttr(ref)) continue;
    if (ref.attrName === "srcset" || ref.attrName === "data-srcset") {
      const parts = ref.originalValue.split(",");
      const rebuilt = parts.map((part) => {
        const tokens = part.trim().split(/\s+/);
        const rawUrl = tokens[0];
        if (!rawUrl) return part.trim();
        const resolved = resolveUrl(rawUrl, sourceUrl);
        const replacement = resolved ? replacementMap.get(resolved) : null;
        return replacement ? [replacement, ...tokens.slice(1)].join(" ") : part.trim();
      });
      patches.push({
        offset: ref.offsets.start,
        length: ref.offsets.end - ref.offsets.start,
        replacement: rebuilt.join(", "),
      });
      continue;
    }
    const resolved = resolveUrl(ref.originalValue, sourceUrl);
    if (!resolved) continue;
    const replacement = replacementMap.get(resolved);
    if (!replacement) continue;
    patches.push({
      offset: ref.offsets.start,
      length: ref.offsets.end - ref.offsets.start,
      replacement,
    });
  }
  patches.sort((a, b) => b.offset - a.offset);
  let result = renderedHtml;
  for (const patch of patches) {
    result = result.slice(0, patch.offset) + patch.replacement + result.slice(patch.offset + patch.length);
  }
  return result;
}

function rewriteCssContent(css: string, sourceUrl: string, replacementMap: Map<string, string>): string {
  const replaceUrlToken = (rawToken: string): string => {
    const cleaned = rawToken.trim().replace(/^['"]|['"]$/g, "");
    const resolved = resolveUrl(cleaned, sourceUrl);
    return (resolved && replacementMap.get(resolved)) || cleaned;
  };

  return css
    .replace(/url\(([^)]+)\)/gi, (_match, token) => `url(${replaceUrlToken(token)})`)
    .replace(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?/gi, (_match, token) => `@import url("${replaceUrlToken(token)}")`);
}

function buildOriginProxyPrefix(rawOrigin: string): string {
  const url = new URL(rawOrigin);
  const protocol = url.protocol.replace(":", "");
  return `/__origin__/${protocol}/${url.host}`;
}

function buildMirrorPrefix(rawOrigin: string): string {
  const url = new URL(rawOrigin);
  const protocol = url.protocol.replace(":", "");
  return `/assets/mirror/${protocol}/${url.host}`;
}

function replaceOriginPrefix(js: string, rawOrigin: string, replacementPrefix: string): string {
  const normalized = rawOrigin.replace(/\/$/, "");
  const protocolLess = normalized.replace(/^https?:/, "");
  let result = js.split(`${normalized}/`).join(`${replacementPrefix}/`);
  result = result.split(normalized).join(replacementPrefix);
  result = result.split(`${protocolLess}/`).join(`${replacementPrefix}/`);
  result = result.split(protocolLess).join(replacementPrefix);
  return result;
}

function rewriteJsContent(
  js: string,
  sourceOrigin: string,
  mirroredOrigins: Set<string>,
  runtimeOrigins: Set<string>,
): string {
  let result = js;

  const originRouteEntries = [
    [sourceOrigin, buildOriginProxyPrefix(sourceOrigin)],
    ...[...runtimeOrigins]
      .filter((origin) => origin !== sourceOrigin)
      .map((origin) => [origin, buildOriginProxyPrefix(origin)] as const),
    ...[...mirroredOrigins]
      .filter((origin) => origin !== sourceOrigin && !runtimeOrigins.has(origin))
      .map((origin) => [origin, buildMirrorPrefix(origin)] as const),
  ].sort((a, b) => b[0].length - a[0].length);

  for (const [origin, replacementPrefix] of originRouteEntries) {
    result = replaceOriginPrefix(result, origin, replacementPrefix);
  }

  return result;
}

async function main(): Promise<void> {
  const { url, force } = parseArgs(process.argv.slice(2));
  if (!url || process.exitCode) {
    process.exitCode = 1;
    return;
  }

  const sourceUrl = new URL(url).toString();
  const sourceOrigin = new URL(sourceUrl).origin;
  const siteName = siteNameFromUrl(sourceUrl);
  const projectRoot = process.cwd();
  const siteRoot = join(projectRoot, "sites", siteName);

  ensureCleanDir(siteRoot, force);
  createSiteLayout(siteRoot);

  const now = new Date().toISOString();
  const siteMeta: SiteMeta = {
    name: siteName,
    sourceUrl,
    finalUrl: sourceUrl,
    capturedAt: now,
    status: "CAPTURING",
    browserTool: "playwright-core (headed Chrome, persistent profile, capture-time mirroring)",
    localized: false,
    entry: "index.html",
    viewport: { width: 0, height: 0 },
    updatedAt: now,
    statistics: {
      totalResources: 0,
      remainingExternalUrls: 0,
      consoleEntries: 0,
      requests: 0,
    },
  };
  writeJson(join(siteRoot, "site.json"), siteMeta);

  const { chromium } = await loadPlaywright();
  const userDataDir = join(projectRoot, PROFILE_DIR);

  const consoleEntries: ConsoleEntry[] = [];
  const requestEntries: ResourceEntry[] = [];
  const requestMap = new Map<any, ResourceEntry>();
  const responseTasks: Promise<void>[] = [];
  const replacementMap = new Map<string, string>();
  const runtimeMap = new Map<string, string>();
  const mirroredOrigins = new Set<string>();
  const runtimeOrigins = new Set<string>();
  const textAssetCache = new Map<string, { content: string; contentType: string; sourceUrl: string; diskPath: string }>();

  let bootstrapContext: any;
  let captureContext: any;

  try {
    bootstrapContext = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: false,
      viewport: null,
      args: [`--window-size=${DEFAULT_BOOTSTRAP_WIDTH},${DEFAULT_BOOTSTRAP_HEIGHT}`, "--window-position=0,0"],
    });

    const bootstrapPage = bootstrapContext.pages()[0] ?? (await bootstrapContext.newPage());
    await bootstrapPage.goto("about:blank", { waitUntil: "domcontentloaded" });
    const screenProbe = await readViewportProbe(bootstrapPage);

    const chromeWidth = Math.max(0, screenProbe.outerWidth - screenProbe.innerWidth);
    const chromeHeight = Math.max(0, screenProbe.outerHeight - screenProbe.innerHeight);
    const launchWidth = Math.max(800, screenProbe.availWidth + chromeWidth);
    const launchHeight = Math.max(600, screenProbe.availHeight + chromeHeight);

    await bootstrapContext.close();
    bootstrapContext = null;

    captureContext = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: false,
      viewport: null,
      args: [`--window-size=${launchWidth},${launchHeight}`, "--window-position=0,0"],
    });

    await captureContext.addInitScript(installDynamicAssetProbeScript());
    const page = captureContext.pages()[0] ?? (await captureContext.newPage());

    page.on("console", (msg: any) => {
      consoleEntries.push({
        type: msg.type(),
        text: msg.text(),
        location: msg.location()?.url,
      });
    });

    page.on("request", (request: any) => {
      const entry: ResourceEntry = {
        id: requestEntries.length + 1,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: null,
        failed: false,
        classification: "ignore",
        include: false,
        kind: "other",
      };
      requestEntries.push(entry);
      requestMap.set(request, entry);
    });

    page.on("requestfailed", (request: any) => {
      const entry = requestMap.get(request);
      if (!entry) return;
      entry.failed = true;
      entry.failureText = request.failure()?.errorText;
    });

    page.on("response", (response: any) => {
      const request = response.request();
      const entry = requestMap.get(request);
      if (!entry) return;
      entry.status = response.status();
      const contentType = response.headers()["content-type"] ?? "";
      entry.contentType = contentType;
      entry.classification = classifyResource(entry.url, entry.method, entry.resourceType, contentType);
      entry.include = shouldInclude(entry.classification) && response.status() >= 200 && response.status() < 300;
      entry.kind = detectKind(entry.resourceType, contentType, entry.url);

      if (!entry.include) return;
      responseTasks.push((async () => {
        let body: Buffer | null;
        try {
          body = await readResponseBodyWithTimeout(response, 12000);
        } catch {
          return;
        }
        if (!body) return;
        entry.contentLength = body.length;
        if (!body.length) return;

        if (entry.kind === "data") {
          const { publicPath, diskPath } = buildResponsePaths(siteRoot, entry.url, entry.contentType ?? "");
          mkdirSync(dirname(diskPath), { recursive: true });
          writeFileSync(diskPath, body);
          entry.localPath = publicPath;
          entry.responseBodyPath = publicPath;
          entry.requestKey = normalizeRequestKey(entry.url);
          runtimeMap.set(entry.requestKey, publicPath);
          runtimeOrigins.add(new URL(entry.url).origin);
          return;
        }

        const { publicPath, diskPath } = buildMirrorPaths(siteRoot, entry.url, entry.contentType ?? "");
        mkdirSync(dirname(diskPath), { recursive: true });
        writeFileSync(diskPath, body);
        entry.localPath = publicPath;
        replacementMap.set(entry.url, publicPath);
        mirroredOrigins.add(new URL(entry.url).origin);
        if (entry.contentType?.includes("text/css")) {
          textAssetCache.set(entry.url, {
            content: body.toString("utf-8"),
            contentType: entry.contentType,
            sourceUrl: entry.url,
            diskPath,
          });
        } else if (entry.contentType?.includes("javascript")) {
          textAssetCache.set(entry.url, {
            content: body.toString("utf-8"),
            contentType: entry.contentType,
            sourceUrl: entry.url,
            diskPath,
          });
        }
      })());
    });

    const cdp = await captureContext.newCDPSession(page);
    const currentProbe = await readViewportProbe(page);
    const widthError = screenProbe.availWidth - currentProbe.innerWidth;
    const heightError = screenProbe.availHeight - currentProbe.innerHeight;
    if (widthError !== 0 || heightError !== 0) {
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: 0,
          top: 0,
          width: currentProbe.outerWidth + widthError,
          height: currentProbe.outerHeight + heightError,
        },
      });
      await page.waitForTimeout(800);
    }

    const calibratedViewport = await page.evaluate(() => {
      const g = globalThis as any;
      return { innerWidth: g.innerWidth, innerHeight: g.innerHeight };
    });

    await page.goto(sourceUrl, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => undefined);
    console.log("[capture] initial navigation complete");
    const stableChecks = await waitForStableHome(page);
    console.log("[capture] stable home checks passed");

    const renderedHtml = await page.evaluate(() => {
      const g = globalThis as any;
      return g.document.documentElement.outerHTML;
    });
    const visibleText = await page.evaluate(() => {
      const g = globalThis as any;
      return g.document.body.innerText;
    });
    const finalViewport = await page.evaluate(() => {
      const g = globalThis as any;
      return { innerWidth: g.innerWidth, innerHeight: g.innerHeight };
    });
    const dynamicAssets = (await page.evaluate(() => {
      const g = globalThis as any;
      return g.__wdDynamicAssets || [];
    })) as DynamicAssetRecord[];
    console.log("[capture] baseline DOM exported before interactions");

    await page.screenshot({
      path: join(siteRoot, "capture", "screenshots", "initial.png"),
      fullPage: false,
    });

    await page.evaluate(async () => {
      const g = globalThis as any;
      await new Promise<void>((resolve) => {
        let total = 0;
        const step = 900;
        const timer = g.setInterval(() => {
          g.scrollBy(0, step);
          total += step;
          if (total >= g.document.documentElement.scrollHeight) {
            g.clearInterval(timer);
            resolve();
          }
        }, 120);
      });
    });
    await page.waitForTimeout(1800);
    console.log("[capture] scroll complete");
    await triggerSafeInteractions(page);
    console.log("[capture] safe interactions complete");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    console.log("[capture] post-interaction network settled");

    await page.screenshot({
      path: join(siteRoot, "capture", "screenshots", "after-scroll.png"),
      fullPage: false,
    });
    await page.screenshot({
      path: join(siteRoot, "capture", "screenshots", "full-page.png"),
      fullPage: true,
    });

    await Promise.allSettled(responseTasks);
    console.log("[capture] response body collection complete");

    for (const item of textAssetCache.values()) {
      writeFileSync(item.diskPath, item.content, "utf-8");
    }
    console.log("[capture] mirrored text assets saved (unmodified)");

    writeFileSync(join(siteRoot, "capture", "rendered.html"), renderedHtml, "utf-8");
    writeFileSync(join(siteRoot, "index.html"), renderedHtml, "utf-8");
    writeFileSync(join(siteRoot, "capture", "visible-text.txt"), visibleText, "utf-8");
    writeJson(join(siteRoot, "capture", "network.json"), {
      tool: "playwright-core",
      requests: requestEntries.map(({ responseBodyPath, ...rest }) => rest),
    });
    writeJson(join(siteRoot, "capture", "console.json"), {
      tool: "playwright-core",
      entries: consoleEntries,
    });
    writeJson(join(siteRoot, "capture", "resources.json"), {
      sourceUrl,
      dynamicAssets,
      resources: requestEntries,
    });

    const runtimeManifest = requestEntries
      .filter((entry) => entry.kind === "data" && entry.include && entry.requestKey && entry.localPath)
      .map((entry) => ({
        requestKey: entry.requestKey!,
        sourceUrl: entry.url,
        publicPath: entry.localPath!,
        contentType: entry.contentType ?? "",
      }));
    writeJson(join(siteRoot, "data", "runtime-origin-map.json"), runtimeManifest);
    console.log("[capture] site artifacts written");

    const remainingExternalUrls = new Set(
      [...renderedHtml.matchAll(/https?:\/\/[^"' )>]+/g)].map((match) => match[0]),
    );

    siteMeta.finalUrl = page.url();
    siteMeta.updatedAt = new Date().toISOString();
    siteMeta.viewport.width = finalViewport.innerWidth;
    siteMeta.viewport.height = finalViewport.innerHeight;
    siteMeta.statistics = {
      totalResources: requestEntries.length,
      remainingExternalUrls: remainingExternalUrls.size,
      consoleEntries: consoleEntries.length,
      requests: requestEntries.length,
    };
    siteMeta.status =
      stableChecks.headerReady && stableChecks.primaryCategoriesReady && requestEntries.length > 0
        ? "CAPTURED"
        : "CAPTURED_WITH_GAPS";
    writeJson(join(siteRoot, "site.json"), siteMeta);

    const mirroredCount = requestEntries.filter((entry) => entry.include && entry.kind !== "data" && entry.localPath).length;
    const mockedCount = requestEntries.filter((entry) => entry.include && entry.kind === "data" && entry.localPath).length;
    const summary: CaptureSummary = {
      stableChecks,
      screenProbe,
      launchWindow: { width: launchWidth, height: launchHeight },
      calibratedViewport,
      finalViewport,
      requestCount: requestEntries.length,
      consoleCount: consoleEntries.length,
      mirroredResources: mirroredCount,
      mockedResponses: mockedCount,
    };
    writeJson(join(siteRoot, "reports", "capture-summary.json"), summary);

    const summaryMd = [
      `# Capture Summary`,
      ``,
      `- Site: \`${siteName}\``,
      `- Source: ${sourceUrl}`,
      `- Final URL: ${siteMeta.finalUrl}`,
      `- Status: \`${siteMeta.status}\``,
      `- Screen avail: ${screenProbe.availWidth} x ${screenProbe.availHeight}`,
      `- Launch window: ${launchWidth} x ${launchHeight}`,
      `- Final viewport: ${finalViewport.innerWidth} x ${finalViewport.innerHeight}`,
      `- Requests: ${requestEntries.length}`,
      `- Console entries: ${consoleEntries.length}`,
      `- Mirrored assets: ${mirroredCount}`,
      `- Mocked display responses: ${mockedCount}`,
      `- Remaining external URLs in index.html: ${remainingExternalUrls.size}`,
      `- DOM exported before any scroll/interaction`,
      ``,
      `## Stable Checks`,
      ``,
      `- Header ready: ${stableChecks.headerReady}`,
      `- PC categories ready: ${stableChecks.primaryCategoriesReady}`,
      `- Sidebar ready: ${stableChecks.sidebarReady}`,
    ].join("\n");
    writeFileSync(join(siteRoot, "reports", "capture-summary.md"), summaryMd + "\n", "utf-8");

    console.log(`Captured ${sourceUrl}`);
    console.log(`Site directory: ${siteRoot}`);
    console.log(`Viewport: ${finalViewport.innerWidth}x${finalViewport.innerHeight}`);
    console.log(`Requests: ${requestEntries.length}`);
    console.log(`Mirrored assets: ${mirroredCount}`);
    console.log(`Mocked display responses: ${mockedCount}`);
    console.log(`Status: ${siteMeta.status}`);
  } catch (error) {
    siteMeta.status = "FAILED";
    siteMeta.updatedAt = new Date().toISOString();
    writeJson(join(siteRoot, "site.json"), siteMeta);
    throw error;
  } finally {
    if (captureContext) await captureContext.close().catch(() => undefined);
    if (bootstrapContext) await bootstrapContext.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
