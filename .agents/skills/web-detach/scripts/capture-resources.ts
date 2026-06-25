import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join, posix, dirname } from "node:path";

type CaptureArgs = {
  outputDir: string;
  targetUrl: string;
};

type CapturedResource = {
  url: string;
  status: number;
  contentType: string;
  path: string;
  size: number;
};

async function main(): Promise<void> {
  const args = parseArgs();
  const { outputDir, targetUrl } = args;

  console.error(`[capture-resources] Launching browser...`);

  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  const captured: CapturedResource[] = [];
  const errors: string[] = [];

  page.on("response", (response) => {
    const url = response.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const status = response.status();
    if (status < 200 || status >= 400) return;

    response
      .body()
      .then((buffer) => {
        if (!buffer || buffer.length === 0) return;
        const parsed = new URL(url);
        const protocol = parsed.protocol.replace(":", "");
        const segments = parsed.pathname.split("/").filter(Boolean);
        let filename = segments.pop() || "index";
        const ext = extname(filename);
        if (!ext) {
          const ct = (response.headers()["content-type"] || "").toLowerCase();
          if (ct.includes("text/css")) filename += ".css";
          else if (ct.includes("javascript")) filename += ".js";
          else if (ct.includes("text/html")) filename += ".html";
          else if (ct.includes("image/svg+xml")) filename += ".svg";
          else if (ct.includes("image/png")) filename += ".png";
          else if (ct.includes("image/jpeg")) filename += ".jpg";
          else if (ct.includes("image/webp")) filename += ".webp";
          else if (ct.includes("font/woff2")) filename += ".woff2";
          else if (ct.includes("font/woff")) filename += ".woff";
          else if (ct.includes("application/json")) filename += ".json";
          else filename += ".bin";
        }
        if (parsed.search) {
          const nameExt = extname(filename);
          const base = nameExt ? filename.slice(0, -nameExt.length) : filename;
          // Strip cache-busting params for stable hashing across capture runs
          const CACHE_BUST = new Set(["_t", "_", "r", "ts", "timestamp", "cb", "callback"]);
          const params = new URLSearchParams(parsed.search);
          for (const key of [...params.keys()]) {
            if (CACHE_BUST.has(key)) params.delete(key);
          }
          const stable = new URLSearchParams();
          for (const key of [...params.keys()].sort()) {
            for (const v of params.getAll(key)) stable.append(key, v);
          }
          const normQuery = stable.toString();
          const hash = createHash("sha1").update(normQuery).digest("hex").slice(0, 10);
          filename = base + "__" + hash + (nameExt || "");
        }
        const relPath = posix.join("assets", "mirror", protocol, parsed.host, ...segments, filename);
        const diskPath = join(outputDir, relPath);
        mkdirSync(dirname(diskPath), { recursive: true });
        writeFileSync(diskPath, buffer);
        captured.push({ url, status, contentType: response.headers()["content-type"] || "", path: relPath, size: buffer.length });
      })
      .catch((e) => {
        errors.push(`${url.slice(0, 60)}: ${(e as Error).message?.slice(0, 40) || "unknown"}`);
      });
  });

  console.error(`[capture-resources] Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Wait for network to settle: up to 30s of network idle
  try {
    await page.waitForLoadState("networkidle", { timeout: 30000 });
  } catch {
    console.error(`[capture-resources] networkidle timeout, capturing what's loaded...`);
  }
  await page.waitForTimeout(5000);

  await browser.close();

  // Write URL→localPath manifest for the localize phase
  const manifest = captured.map((r) => ({
    url: r.url,
    localPath: r.path,
    contentType: r.contentType,
  }));
  const manifestPath = join(outputDir, "assets", "mirror", "manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: manifest }, null, 2) + "\n", "utf-8");
  console.error(`[capture-resources] Manifest written: ${manifest.length} entries`);

  const total = captured.length;
  const totalBytes = captured.reduce((s, r) => s + r.size, 0);
  console.log(JSON.stringify({ total, totalBytes, errors: errors.length > 0 ? errors : undefined }));
  console.error(`[capture-resources] Done: ${total} resources, ${(totalBytes / 1024).toFixed(1)}KB`);
}

function parseArgs(): CaptureArgs {
  const argv = process.argv.slice(2);
  let outputDir = "";
  let targetUrl = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output-dir" && i + 1 < argv.length) outputDir = argv[++i];
    else if (argv[i] === "--url" && i + 1 < argv.length) targetUrl = argv[++i];
    else if (!argv[i].startsWith("--") && !targetUrl) targetUrl = argv[i];
  }
  if (!outputDir || !targetUrl) {
    console.error("Usage: tsx capture-resources.ts --output-dir <path> --url <url>");
    process.exit(1);
  }
  return { outputDir, targetUrl };
}

main().catch((err) => {
  console.error("[capture-resources] Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
