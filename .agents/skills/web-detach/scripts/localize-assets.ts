import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, posix } from "node:path";

type Document = DefaultTreeAdapterMap["document"];
type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];

interface Patch {
  offset: number;
  length: number;
  replacement: string;
}

interface NetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  failed?: boolean;
}

interface AssetRef {
  attrName: string;
  originalValue: string;
  offsets: { start: number; end: number };
  kind: "css" | "script" | "image" | "font" | "iframe" | "other";
}

interface MirroredAsset {
  sourceUrl: string;
  publicPath: string;
  diskPath: string;
  contentType: string;
}

interface RuntimeManifestEntry {
  requestKey: string;
  sourceUrl: string;
  publicPath: string;
  contentType: string;
}

const DIRECT_ATTRS = new Set(["src", "href", "poster"]);
const URLISH_IMAGE_ATTRS = new Set([
  "src",
  "srcset",
  "data-src",
  "data-srcset",
  "data-original",
  "data-lazy-src",
  "poster",
]);
const RUNTIME_QUERY_DROP = new Set(["_t", "_", "r", "ts", "timestamp", "cb", "callback"]);

function parseArgs(argv: string[]): { siteName: string | null } {
  let siteName: string | null = null;
  for (const arg of argv) {
    if (!arg.startsWith("--") && siteName === null) {
      siteName = arg;
    }
  }
  if (!siteName || !/^[a-zA-Z0-9_-]+$/.test(siteName)) {
    console.error("Usage: pnpm site:localize-assets -- <site-name>");
    process.exitCode = 1;
  }
  return { siteName };
}

function walkNodes(node: Node, callback: (el: Element) => void): void {
  if ("tagName" in node && node.tagName) {
    callback(node as Element);
  }
  if ("childNodes" in node && node.childNodes) {
    for (const child of (node as { childNodes: Node[] }).childNodes) {
      walkNodes(child, callback);
    }
  }
}

function resolveUrl(raw: string, base: string): string | null {
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("javascript:")) {
    return null;
  }
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function sha(text: string, len = 10): string {
  return createHash("sha1").update(text).digest("hex").slice(0, len);
}

function resolveToLocalPath(siteRoot: string, url: string): string | null {
  // Build the same path as capture-resources.js uses:
  // assets/mirror/<protocol>/<host>/<path>
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.replace(":", "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    let filename = segments.pop() || "index";
    const ext = extname(filename);
    if (!ext) filename += ".bin";
    if (parsed.search) {
      const nameExt = extname(filename);
      const base = nameExt ? filename.slice(0, -nameExt.length) : filename;
      filename = `${base}__${sha(parsed.search)}${nameExt || ".bin"}`;
    }
    const relPath = posix.join("assets", "mirror", protocol, parsed.host, ...segments, filename);
    const diskPath = join(siteRoot, relPath);
    if (existsSync(diskPath)) {
      return `./${relPath}`;
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extFromContentType(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("text/css")) return ".css";
  if (lower.includes("javascript")) return ".js";
  if (lower.includes("application/json")) return ".json";
  if (lower.includes("image/svg+xml")) return ".svg";
  if (lower.includes("image/png")) return ".png";
  if (lower.includes("image/jpeg")) return ".jpg";
  if (lower.includes("image/webp")) return ".webp";
  if (lower.includes("image/gif")) return ".gif";
  if (lower.includes("font/woff2")) return ".woff2";
  if (lower.includes("font/woff")) return ".woff";
  if (lower.includes("font/ttf")) return ".ttf";
  if (lower.includes("font/otf")) return ".otf";
  if (lower.includes("text/html")) return ".html";
  return ".bin";
}

function buildAssetPaths(siteRoot: string, url: string, contentTypeHint = ""): { publicPath: string; diskPath: string } {
  const parsed = new URL(url);
  const protocol = parsed.protocol.replace(":", "");
  const ext = extname(parsed.pathname) || extFromContentType(contentTypeHint);
  const rawSegments = parsed.pathname.split("/").filter(Boolean).map(sanitizeSegment);
  let filename = rawSegments.pop() ?? "index";
  if (!extname(filename)) {
    filename += ext;
  }
  if (parsed.search) {
    const nameExt = extname(filename);
    const base = nameExt ? filename.slice(0, -nameExt.length) : filename;
    filename = `${base}__${sha(parsed.search)}${nameExt || ext}`;
  }
  const relPath = posix.join("assets", "mirror", protocol, parsed.host, ...rawSegments, filename);
  return {
    publicPath: `/${relPath}`,
    diskPath: join(siteRoot, relPath),
  };
}

function buildRuntimePaths(siteRoot: string, url: string, contentTypeHint = ""): { publicPath: string; diskPath: string } {
  const ext = extFromContentType(contentTypeHint);
  const name = `${sha(url, 16)}${ext}`;
  const relPath = posix.join("assets", "runtime", name);
  return {
    publicPath: `/${relPath}`,
    diskPath: join(siteRoot, relPath),
  };
}

function normalizeRuntimeKey(url: string): string {
  const parsed = new URL(url);
  const query = new URLSearchParams(parsed.search);
  for (const key of [...query.keys()]) {
    if (RUNTIME_QUERY_DROP.has(key)) {
      query.delete(key);
    }
  }
  const stable = new URLSearchParams();
  for (const key of [...query.keys()].sort()) {
    const values = query.getAll(key);
    for (const value of values) {
      stable.append(key, value);
    }
  }
  const suffix = stable.toString();
  return suffix ? `${parsed.origin}${parsed.pathname}?${suffix}` : `${parsed.origin}${parsed.pathname}`;
}

function classifyLinkKind(el: Element): AssetRef["kind"] {
  const rel = (el.attrs.find((attr) => attr.name === "rel")?.value ?? "").toLowerCase();
  const asValue = (el.attrs.find((attr) => attr.name === "as")?.value ?? "").toLowerCase();
  if (rel.includes("stylesheet")) return "css";
  if (asValue === "font") return "font";
  if (asValue === "script") return "script";
  if (asValue === "image") return "image";
  return "other";
}

function resolveAttrValueOffsets(
  html: string,
  startOffset: number,
  endOffset: number,
  originalValue: string,
): { start: number; end: number } | null {
  const raw = html.slice(startOffset, endOffset);
  const eqIndex = raw.indexOf("=");
  if (eqIndex === -1) return null;
  const valueArea = raw.slice(eqIndex + 1).trimStart();
  const valueAreaOffset = raw.indexOf(valueArea, eqIndex + 1);
  if (valueAreaOffset === -1) return null;

  const firstChar = valueArea[0];
  if (firstChar === `"` || firstChar === `'`) {
    const closingIndex = valueArea.indexOf(firstChar, 1);
    if (closingIndex === -1) return null;
    return {
      start: startOffset + valueAreaOffset + 1,
      end: startOffset + valueAreaOffset + closingIndex,
    };
  }

  const valueIndex = raw.indexOf(originalValue, eqIndex + 1);
  if (valueIndex === -1) return null;
  return {
    start: startOffset + valueIndex,
    end: startOffset + valueIndex + originalValue.length,
  };
}

function extractAssetRefs(doc: Document, html: string): AssetRef[] {
  const refs: AssetRef[] = [];

  walkNodes(doc, (el) => {
    const tag = el.tagName.toLowerCase();

    for (const attr of el.attrs) {
      const loc = el.sourceCodeLocation?.attrs?.[attr.name];
      if (!loc) continue;
      const valueOffsets = resolveAttrValueOffsets(html, loc.startOffset, loc.endOffset, attr.value);
      if (!valueOffsets) continue;

      let kind: AssetRef["kind"] | null = null;
      if (tag === "script" && attr.name === "src") kind = "script";
      if (tag === "iframe" && attr.name === "src") kind = "iframe";
      if (tag === "link" && attr.name === "href") kind = classifyLinkKind(el);
      if ((tag === "img" || tag === "source" || tag === "video" || tag === "image" || tag === "use") && URLISH_IMAGE_ATTRS.has(attr.name)) {
        kind = "image";
      }
      if (tag === "input" && attr.name === "src") {
        const typeAttr = el.attrs.find((item) => item.name === "type")?.value;
        if (typeAttr === "image") kind = "image";
      }

      if (!kind) continue;

      refs.push({
        attrName: attr.name,
        originalValue: attr.value,
        offsets: valueOffsets,
        kind,
      });
    }
  });

  return refs;
}

async function fetchBuffer(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer": "https://www.made-in-china.com/",
      "Origin": "https://www.made-in-china.com",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

async function fetchText(url: string): Promise<{ text: string; contentType: string }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer": "https://www.made-in-china.com/",
      "Origin": "https://www.made-in-china.com",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return {
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? "text/plain",
  };
}

const mirroredAssets = new Map<string, Promise<MirroredAsset>>();

async function mirrorStaticAsset(
  siteRoot: string,
  url: string,
  runtimeHosts: Set<string>,
): Promise<MirroredAsset> {
  const existing = mirroredAssets.get(url);
  if (existing) return existing;

  const promise = (async () => {
    const { buffer, contentType } = await fetchBuffer(url);
    const { publicPath, diskPath } = buildAssetPaths(siteRoot, url, contentType);
    let output = buffer;
    if (contentType.includes("text/css")) {
      const css = buffer.toString("utf-8");
      const rewritten = await rewriteCss(siteRoot, css, url, runtimeHosts);
      output = Buffer.from(rewritten, "utf-8");
    } else if (contentType.includes("javascript")) {
      const js = buffer.toString("utf-8");
      output = Buffer.from(rewriteRuntimeOrigins(js, runtimeHosts), "utf-8");
    }

    ensureDir(diskPath);
    writeFileSync(diskPath, output);
    return { sourceUrl: url, publicPath, diskPath, contentType };
  })();

  mirroredAssets.set(url, promise);
  return promise;
}

async function rewriteCss(siteRoot: string, css: string, baseUrl: string, runtimeHosts: Set<string>): Promise<string> {
  const replacements = new Map<string, string>();
  const patterns = [
    /url\((['"]?)([^)'"]+)\1\)/g,
    /@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g,
  ];

  for (const pattern of patterns) {
    for (const match of css.matchAll(pattern)) {
      const raw = match[2] ?? match[1];
      if (!raw) continue;
      const resolved = resolveUrl(raw.trim(), baseUrl);
      if (!resolved) continue;
      try {
        const mirrored = await mirrorStaticAsset(siteRoot, resolved, runtimeHosts);
        replacements.set(raw, mirrored.publicPath);
      } catch {
        continue;
      }
    }
  }

  let result = css;
  for (const [from, to] of replacements) {
    result = result.split(from).join(to);
  }
  return result;
}

function rewriteRuntimeOrigins(js: string, runtimeHosts: Set<string>): string {
  let result = js;
  for (const host of runtimeHosts) {
    const protocolRelative = `//${host}/`;
    const httpsAbsolute = `https://${host}/`;
    const httpAbsolute = `http://${host}/`;
    result = result.split(httpsAbsolute).join(`/__origin__/https/${host}/`);
    result = result.split(httpAbsolute).join(`/__origin__/http/${host}/`);
    result = result.split(protocolRelative).join(`/__origin__/https/${host}/`);
  }
  return result;
}

async function mirrorRuntimeResponse(siteRoot: string, url: string): Promise<RuntimeManifestEntry> {
  const { text, contentType } = await fetchText(url);
  const { publicPath, diskPath } = buildRuntimePaths(siteRoot, url, contentType);
  ensureDir(diskPath);
  writeFileSync(diskPath, text, "utf-8");
  return {
    requestKey: normalizeRuntimeKey(url),
    sourceUrl: url,
    publicPath,
    contentType,
  };
}

async function main(): Promise<void> {
  const { siteName } = parseArgs(process.argv.slice(2));
  if (!siteName || process.exitCode) {
    process.exitCode = 1;
    return;
  }

  const projectRoot = process.cwd();
  const siteRoot = join(projectRoot, "sites", siteName);
  const htmlPath = join(siteRoot, "index.html");

  if (!existsSync(htmlPath)) {
    console.error("Missing index.html in site directory.");
    process.exitCode = 1;
    return;
  }

  // Detect mode from webdetach.json
  const webdetachPath = join(siteRoot, "webdetach.json");
  const isOffline = existsSync(webdetachPath)
    ? (JSON.parse(readFileSync(webdetachPath, "utf-8")) as { mode?: string }).mode === "offline"
    : false;

  const networkPath = join(siteRoot, "capture", "network.json");
  if (!isOffline && !existsSync(networkPath)) {
    console.error("Missing capture/network.json. Run capture first.");
    process.exitCode = 1;
    return;
  }

  const html = readFileSync(htmlPath, "utf-8");
  const doc = parse(html, { sourceCodeLocationInfo: true }) as Document;
  const refs = extractAssetRefs(doc, html);

  let baseUrl: string;
  let runtimeHosts = new Set<string>();
  let networkData: { requests: NetworkEntry[] } = { requests: [] };

  if (isOffline) {
    const config = JSON.parse(readFileSync(webdetachPath, "utf-8")) as { sourceUrl: string };
    baseUrl = config.sourceUrl || "https://unknown/";
  } else {
    baseUrl = "https://www.made-in-china.com/";
    networkData = JSON.parse(readFileSync(networkPath, "utf-8")) as { requests: NetworkEntry[] };
    runtimeHosts = new Set(
      networkData.requests
        .filter((entry) => ["fetch", "xhr"].includes(entry.resourceType) && entry.status === 200)
        .map((entry) => new URL(entry.url).host),
    );
  }

  const patches: Patch[] = [];

  for (const ref of refs) {
    // Skip font references (browser fallback to system fonts, avoid copyright risk)
    if (ref.kind === "font") continue;

    if (ref.attrName === "srcset" || ref.attrName === "data-srcset") {
      const parts = ref.originalValue.split(",");
      const rebuilt: string[] = [];
      let changed = false;
      for (const part of parts) {
        const tokens = part.trim().split(/\s+/);
        const rawUrl = tokens[0];
        if (!rawUrl) continue;
      const resolved = resolveUrl(rawUrl, baseUrl);
      if (!resolved) {
        rebuilt.push(part.trim());
        continue;
      }
      if (isOffline) {
        const localPath = resolveToLocalPath(siteRoot, resolved);
        if (localPath) {
          rebuilt.push([localPath, ...tokens.slice(1)].join(" "));
          changed = true;
        } else {
          rebuilt.push(part.trim());
        }
      } else {
        try {
          const mirrored = await mirrorStaticAsset(siteRoot, resolved, runtimeHosts);
          rebuilt.push([mirrored.publicPath, ...tokens.slice(1)].join(" "));
          changed = true;
        } catch {
          rebuilt.push(part.trim());
        }
      }
      }
      if (changed) {
        patches.push({
          offset: ref.offsets.start,
          length: ref.offsets.end - ref.offsets.start,
          replacement: rebuilt.join(", "),
        });
      }
      continue;
    }

    if (!DIRECT_ATTRS.has(ref.attrName) || ref.kind === "other") continue;
    const resolved = resolveUrl(ref.originalValue, baseUrl);
    if (!resolved) continue;
    if (ref.kind === "iframe" && new URL(resolved).pathname.endsWith("/faw-store.html")) {
      patches.push({
        offset: ref.offsets.start,
        length: ref.offsets.end - ref.offsets.start,
        replacement: "about:blank",
      });
      continue;
    }

    if (isOffline) {
      const localPath = resolveToLocalPath(siteRoot, resolved);
      if (localPath) {
        patches.push({
          offset: ref.offsets.start,
          length: ref.offsets.end - ref.offsets.start,
          replacement: localPath,
        });
      }
    } else {
      try {
        const mirrored = await mirrorStaticAsset(siteRoot, resolved, runtimeHosts);
        patches.push({
          offset: ref.offsets.start,
          length: ref.offsets.end - ref.offsets.start,
          replacement: mirrored.publicPath,
        });
      } catch {
        continue;
      }
    }
  }

  patches.sort((a, b) => b.offset - a.offset);
  let rewrittenHtml = html;
  for (const patch of patches) {
    rewrittenHtml =
      rewrittenHtml.slice(0, patch.offset) +
      patch.replacement +
      rewrittenHtml.slice(patch.offset + patch.length);
  }

  if (!isOffline) {
    rewrittenHtml = rewrittenHtml.replace(
      /<base\s+href="\/\/www\.made-in-china\.com"\s+target="_top">/i,
      '<base href="/" target="_self">',
    );
  }
  writeFileSync(htmlPath, rewrittenHtml, "utf-8");

  if (!isOffline) {
    const runtimeEntries = networkData.requests.filter(
      (entry) =>
        ["fetch", "xhr"].includes(entry.resourceType) &&
        entry.method.toUpperCase() === "GET" &&
        entry.status === 200,
    );
    const manifest: RuntimeManifestEntry[] = [];
    for (const entry of runtimeEntries) {
      try {
        manifest.push(await mirrorRuntimeResponse(siteRoot, entry.url));
      } catch (error) {
        console.warn(`Failed runtime mirror: ${entry.url} (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    writeFileSync(
      join(siteRoot, "data", "runtime-origin-map.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
  }

  const report = {
    assetReferencesPatched: patches.length,
    mirroredAssets: isOffline ? 0 : mirroredAssets.size,
    runtimeResponses: isOffline ? 0 : 0,
    runtimeHosts: [...runtimeHosts],
    mode: isOffline ? "offline" : "online",
  };
  writeFileSync(
    join(siteRoot, "reports", "asset-localization.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  console.log(`Localized assets for ${siteName} (mode: ${isOffline ? "offline" : "online"})`);
  console.log(`  HTML patches: ${patches.length}`);
  if (!isOffline) {
    console.log(`  Mirrored static assets: ${mirroredAssets.size}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
