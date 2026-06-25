import { createServer, request as httpReq } from "node:http";
import { request as httpsReq } from "node:https";
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

// ── config ───────────────────────────────────────────────────────────────────

const HOST = "localhost";
const DEFAULT_PORT = 4173;

const VALID_SITE_NAME = /^[a-zA-Z0-9_-]+$/;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const PROJECT_ROOT = normalize(
  join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..")
);

interface RuntimeOriginMapEntry {
  requestKey: string;
  sourceUrl: string;
  publicPath: string;
  contentType: string;
}

interface SiteMeta {
  sourceUrl: string;
}

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(raw: string[]): { siteName: string | null; port: number; offline: boolean } {
  let siteName: string | null = null;
  let port = DEFAULT_PORT;
  let offline = false;

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === "--port" && i + 1 < raw.length) {
      const p = Number(raw[++i]);
      if (Number.isInteger(p) && p >= 0 && p <= 65535) {
        port = p;
      } else {
        console.error(`Invalid port: ${raw[i]}. Must be 0-65535.`);
        process.exitCode = 1;
        return { siteName: null, port, offline };
      }
    } else if (arg === "--offline") {
      offline = true;
    } else if (!arg.startsWith("--") && siteName === null) {
      siteName = arg;
    }
  }

  if (siteName === null) {
    console.error("Usage: pnpm site:serve -- <site-name> [--port <port>] [--offline]");
    process.exitCode = 1;
  }

  return { siteName, port, offline };
}

// ── paths ────────────────────────────────────────────────────────────────────

function resolveSiteRoot(siteName: string): string {
  return join(PROJECT_ROOT, "sites", siteName);
}

function isPathSafe(root: string, target: string): boolean {
  const resolved = normalize(join(root, target));
  const resolvedRoot = normalize(root) + "/";
  return resolved.startsWith(resolvedRoot);
}

// ── mime ─────────────────────────────────────────────────────────────────────

function getContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
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

function buildMirrorRelativePath(rawUrl: string, contentType = ""): string {
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
  return join("assets", "mirror", protocol, url.host, ...segments, filename);
}

function normalizeRuntimeKeyFromRequest(originPath: string, queryString: string): string | null {
  const match = originPath.match(/^\/__origin__\/(https|http)\/([^/]+)(\/.*)$/);
  if (!match) return null;
  const [, protocol, host, pathPart] = match;
  const query = new URLSearchParams(queryString);
  for (const key of [...query.keys()]) {
    if (["r", "_", "_t", "ts", "timestamp", "cb", "callback"].includes(key)) {
      query.delete(key);
    }
  }
  const stable = new URLSearchParams();
  for (const key of [...query.keys()].sort()) {
    for (const value of query.getAll(key)) {
      stable.append(key, value);
    }
  }
  const suffix = stable.toString();
  return suffix
    ? `${protocol}://${host}${pathPart}?${suffix}`
    : `${protocol}://${host}${pathPart}`;
}

// ── handler ──────────────────────────────────────────────────────────────────

function createHandler(siteRoot: string, offline = false) {
  const runtimeMapPath = join(siteRoot, "data", "runtime-origin-map.json");
  const runtimeMap = !offline && existsSync(runtimeMapPath)
    ? (JSON.parse(readFileSync(runtimeMapPath, "utf-8")) as RuntimeOriginMapEntry[])
    : [];
  const runtimeLookup = new Map(runtimeMap.map((entry) => [entry.requestKey, entry]));
  const siteMetaPath = join(siteRoot, "site.json");
  const siteMeta = existsSync(siteMetaPath)
    ? (JSON.parse(readFileSync(siteMetaPath, "utf-8")) as SiteMeta)
    : null;
  const sourceOrigin = !offline && siteMeta?.sourceUrl ? new URL(siteMeta.sourceUrl).origin : null;

  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const method = req.method?.toUpperCase() ?? "GET";

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }

    // Decode and normalize path, strip query
    const [rawPath, rawQuery = ""] = (req.url ?? "/").split("?");
    const decoded = decodeURIComponent(rawPath);
    let normalized = normalize(decoded).replace(/\\/g, "/");

    // Offline mode: no /__origin__/ routing, no proxy fallback
    if (offline) {
      if (normalized.startsWith("/__origin__/")) {
        res.writeHead(404).end();
        return;
      }
      return serveLocal(res, siteRoot, normalized, method);
    }

    if (normalized.startsWith("/__origin__/")) {
      const match = normalized.match(/^\/__origin__\/(https|http)\/([^/]+)(\/.*)$/);
      if (!match) {
        res.writeHead(404).end();
        return;
      }
      const [, protocol, host, pathPart] = match;
      const runtimeKey = normalizeRuntimeKeyFromRequest(normalized, rawQuery);
      if (!runtimeKey) {
        res.writeHead(404).end();
        return;
      }
      const runtimeEntry = runtimeLookup.get(runtimeKey);
      if (runtimeEntry) {
        const runtimePath = join(siteRoot, runtimeEntry.publicPath.replace(/^\.\//, "").replace(/^\//, ""));
        if (existsSync(runtimePath)) {
          serveFile(res, runtimePath, method);
          return;
        }
      }

      const originUrl = `${protocol}://${host}${pathPart}${rawQuery ? `?${rawQuery}` : ""}`;
      const mirrorCandidate = join(siteRoot, buildMirrorRelativePath(originUrl));
      if (existsSync(mirrorCandidate)) {
        serveFile(res, mirrorCandidate, method);
        return;
      }

      res.writeHead(404).end();
      return;
    }

    // Root → index.html
    if (normalized === "/" || normalized === "" || normalized === ".") {
      normalized = "/index.html";
    } else if (!normalized.startsWith("/")) {
      normalized = "/" + normalized;
    }

    // Security: block path traversal
    if (!isPathSafe(siteRoot, normalized)) {
      res.writeHead(403).end();
      return;
    }

    const filePath = join(siteRoot, normalized);

    // Check file exists
    if (!existsSync(filePath)) {
      if (sourceOrigin) {
        const directRequestKey = normalizeRuntimeKeyFromRequest(
          `/__origin__/${sourceOrigin.startsWith("https://") ? "https" : "http"}/${new URL(sourceOrigin).host}${normalized}`,
          rawQuery,
        );
        const runtimeEntry = directRequestKey ? runtimeLookup.get(directRequestKey) : null;
        if (runtimeEntry) {
          const runtimePath = join(siteRoot, runtimeEntry.publicPath.replace(/^\//, ""));
          if (existsSync(runtimePath)) {
            serveFile(res, runtimePath, method);
            return;
          }
        }

        const mirrorCandidate = join(
          siteRoot,
          buildMirrorRelativePath(`${sourceOrigin}${normalized}${rawQuery ? `?${rawQuery}` : ""}`),
        );
        if (existsSync(mirrorCandidate)) {
          serveFile(res, mirrorCandidate, method);
          return;
        }

        proxyToOrigin(res, `${sourceOrigin}${normalized}${rawQuery ? `?${rawQuery}` : ""}`, req.headers);
        return;
      }

      res.writeHead(404).end();
      return;
    }

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      res.writeHead(404).end();
      return;
    }

    // Directory: try index.html
    if (stat.isDirectory()) {
      const indexPath = join(filePath, "index.html");
      if (existsSync(indexPath)) {
        serveFile(res, indexPath, method);
      } else {
        res.writeHead(404).end();
      }
      return;
    }

    serveFile(res, filePath, method);
  };
}

function serveLocal(
  res: import("node:http").ServerResponse,
  siteRoot: string,
  normalized: string,
  method: string,
): void {
  let path = normalized;
  if (path === "/" || path === "" || path === ".") {
    path = "/index.html";
  } else if (!path.startsWith("/")) {
    path = "/" + path;
  }

  if (!isPathSafe(siteRoot, path)) {
    res.writeHead(403).end();
    return;
  }

  const filePath = join(siteRoot, path);
  if (!existsSync(filePath)) {
    res.writeHead(404).end();
    return;
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    res.writeHead(404).end();
    return;
  }

  if (stat.isDirectory()) {
    const indexPath = join(filePath, "index.html");
    if (existsSync(indexPath)) {
      serveFile(res, indexPath, method);
    } else {
      res.writeHead(404).end();
    }
    return;
  }

  serveFile(res, filePath, method);
}

function serveFile(
  res: import("node:http").ServerResponse,
  filePath: string,
  method: string
) {
  const contentType = getContentType(filePath);
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": contentType,
  };

  if (method === "HEAD") {
    res.writeHead(200, headers).end();
    return;
  }

  try {
    const data = readFileSync(filePath);
    res.writeHead(200, headers).end(data);
  } catch {
    res.writeHead(500).end();
  }
}

function proxyToOrigin(
  res: import("node:http").ServerResponse,
  urlStr: string,
  reqHeaders: import("node:http").IncomingHttpHeaders,
) {
  const url = new URL(urlStr);
  const forwardHeaders: Record<string, string> = {};

  for (const key of ["user-agent", "accept", "accept-language", "cookie"]) {
    const v = reqHeaders[key];
    if (v) forwardHeaders[key] = Array.isArray(v) ? v[0] : v;
  }
  if (!forwardHeaders["user-agent"]) {
    forwardHeaders["user-agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  }

  const req = (url.protocol === "https:" ? httpsReq : httpReq)(url, { headers: forwardHeaders }, (proxyRes) => {
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      const lk = key.toLowerCase();
      if (!["content-encoding", "content-length", "transfer-encoding", "connection",
            "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
            "trailers", "upgrade", "set-cookie"].includes(lk)) {
        headers[key] = value;
      }
    }
    res.writeHead(proxyRes.statusCode ?? 502, headers);
    proxyRes.pipe(res);
  });
  req.on("error", () => { res.writeHead(504).end(); });
  req.end();
}

// ── main ─────────────────────────────────────────────────────────────────────

const { siteName, port, offline } = parseArgs(process.argv.slice(2));

if (siteName === null || process.exitCode === 1) {
  // parseArgs already set exitCode and printed message
  // Use process.exitCode pattern – do NOT call process.exit()
  // Let Node exit naturally with the code
  void 0;
} else if (!VALID_SITE_NAME.test(siteName)) {
  console.error(`Invalid site name: "${siteName}". Use letters, digits, hyphens, or underscores.`);
  process.exitCode = 1;
} else {
  const siteRoot = resolveSiteRoot(siteName);

  if (!existsSync(siteRoot)) {
    console.error(`Site not found: ${siteName}`);
    console.error(`Expected directory: ${siteRoot}`);
    process.exitCode = 1;
  } else if (!existsSync(join(siteRoot, "index.html"))) {
    console.error(`index.html not found in site: ${siteName}`);
    console.error(`Expected: ${join(siteRoot, "index.html")}`);
    process.exitCode = 1;
  } else {
    const handler = createHandler(siteRoot, offline);
    const server = createServer(handler);

    server.listen(port, HOST, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        console.log("WebDetach local site server\n");
        console.log(`Site: ${siteName}`);
        console.log(`Root: ${siteRoot}`);
        console.log(`Mode: ${offline ? "offline (no proxy fallback)" : "online (with proxy fallback)"}`);
        console.log(`URL:  http://${HOST}:${addr.port}`);
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use.`);
        console.error(`Try: pnpm site:serve -- ${siteName} --port 0`);
        console.error(`  or: pnpm site:serve -- ${siteName} --port <other-port>`);
      } else {
        console.error("Server error:", err.message);
      }
      process.exitCode = 1;
    });

    const shutdown = () => server.close();
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}

// IMPORTANT: Do NOT call process.exit(). Let Node exit with process.exitCode.
