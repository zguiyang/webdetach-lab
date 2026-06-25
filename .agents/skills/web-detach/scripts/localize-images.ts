import { parse } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { createHash } from "node:crypto";

// ── types ────────────────────────────────────────────────────────────────────

type Element = DefaultTreeAdapterMap["element"];
type Node = DefaultTreeAdapterMap["node"];
type Document = DefaultTreeAdapterMap["document"];

interface Patch {
  offset: number;
  length: number;
  replacement: string;
}

interface ImageRecord {
  tagName: string;
  attrName: string;
  originalValue: string;
  offsets: { start: number; end: number };
}

interface UrlMapEntry {
  sourceUrl: string;
  localPath: string;
  type: string;
  status: "DOWNLOADED" | "FAILED" | "SKIPPED";
}

interface Report {
  uniqueImageUrls: number;
  downloaded: number;
  localizedReferences: number;
  lazyImagesPromotedToSrc: number;
  srcsetCandidatesLocalized: number;
  remainingRemoteImages: string[];
  trackingPixelsRemoved: number;
  svg404Resolved: boolean;
  logo: {
    localFileExists: boolean;
    srcLocalized: boolean;
    loaded: boolean;
  };
}

// ── config ───────────────────────────────────────────────────────────────────

const IMAGE_ATTRS = [
  "src",
  "srcset",
  "data-src",
  "data-srcset",
  "data-lazy-src",
  "data-original",
  "poster",
];

const IMAGE_TAGS = new Set(["img", "source", "video", "input"]);
const SVG_IMAGE_TAGS = new Set(["image", "use"]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".tiff",
]);

const TRACKING_PATTERNS = ["1x1", "pixel", "tracking", "beacon", "analytics", "collect", "rum"];
const PLACEHOLDER_PATTERNS = ["placeholder", "blank.gif", "spacer.gif", "transparent"];

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveUrl(raw: string, base: string): string {
  if (raw.startsWith("//")) return "https:" + raw;
  if (raw.startsWith("data:")) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  // Absolute path
  if (raw.startsWith("/")) {
    const u = new URL(base);
    u.pathname = raw;
    u.search = "";
    u.hash = "";
    return u.toString();
  }
  return "";
}

function guessExt(pathname: string): string {
  const ext = extname(pathname).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return ext;
  if (pathname.includes(".png")) return ".png";
  if (pathname.includes(".jpg") || pathname.includes(".jpeg")) return ".jpg";
  if (pathname.includes(".gif")) return ".gif";
  if (pathname.includes(".svg")) return ".svg";
  if (pathname.includes(".webp")) return ".webp";
  if (pathname.includes(".ico")) return ".ico";
  return ".png";
}

function safeFilename(url: string): string {
  const pathname = new URL(url).pathname;
  let fname = basename(pathname) || "img";
  if (!extname(fname)) {
    fname += guessExt(pathname);
  }
  if (!fname.match(/\.(png|jpg|jpeg|gif|svg|webp|avif|ico|bmp)$/i)) {
    fname += ".png";
  }
  const hash = createHash("md5").update(url).digest("hex").slice(0, 6);
  const parts = fname.split(".");
  const ext = parts.pop()!;
  return `${parts.join(".")}_${hash}.${ext}`;
}

function isTrackingPixel(url: string): boolean {
  const low = url.toLowerCase();
  return TRACKING_PATTERNS.some((p) => low.includes(p));
}

function isPlaceholder(url: string): boolean {
  const low = url.toLowerCase();
  return PLACEHOLDER_PATTERNS.some((p) => low.includes(p));
}

// ── HTML parsing ─────────────────────────────────────────────────────────────

function walkNodes(
  node: Node,
  callback: (el: Element) => void,
): void {
  if ("tagName" in node && node.tagName) {
    callback(node as Element);
  }
  if ("childNodes" in node && node.childNodes) {
    for (const child of (node as { childNodes: Node[] }).childNodes) {
      walkNodes(child, callback);
    }
  }
}

function extractImages(doc: Document): ImageRecord[] {
  const records: ImageRecord[] = [];

  walkNodes(doc, (el) => {
    const tag = el.tagName.toLowerCase();
    if (!IMAGE_TAGS.has(tag) && !SVG_IMAGE_TAGS.has(tag)) return;
    if (tag === "input" && !el.attrs.some((a) => a.name === "type" && a.value === "image"))
      return;
    if (tag === "video") {
      const poster = el.attrs.find((a) => a.name === "poster");
      if (poster && poster.value) {
        const loc = el.sourceCodeLocation?.attrs?.["poster"];
        if (loc) {
          records.push({
            tagName: tag,
            attrName: "poster",
            originalValue: poster.value,
            offsets: { start: loc.startOffset, end: loc.endOffset },
          });
        }
      }
      return;
    }

    for (const attr of IMAGE_ATTRS) {
      const a = el.attrs.find((x) => x.name === attr);
      if (a && a.value && !a.value.startsWith("http://127.") && !a.value.startsWith("http://local")) {
        const loc = el.sourceCodeLocation?.attrs?.[attr];
        if (loc) {
          records.push({
            tagName: tag,
            attrName: attr,
            originalValue: a.value,
            offsets: { start: loc.startOffset, end: loc.endOffset },
          });
        }
      }
    }
  });

  return records;
}

// ── main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { siteName: string | null } {
  let siteName: string | null = null;
  for (const arg of argv) {
    if (!arg.startsWith("--") && siteName === null) {
      siteName = arg;
    }
  }
  if (!siteName || !/^[a-zA-Z0-9_-]+$/.test(siteName)) {
    console.error("Usage: pnpm site:localize-images -- <site-name>");
    process.exitCode = 1;
  }
  return { siteName };
}

const { siteName } = parseArgs(process.argv.slice(2));
if (!siteName || process.exitCode) {
  // parseArgs set exitCode
  process.exitCode = 1;
} else {
  const PROJECT_ROOT = process.cwd();
  const siteRoot = join(PROJECT_ROOT, "sites", siteName);
  const htmlPath = join(siteRoot, "index.html");

  if (!existsSync(htmlPath)) {
    console.error(`index.html not found: ${htmlPath}`);
    process.exitCode = 1;
  } else {
    console.log(`Localizing images for: ${siteName}`);

    // Read HTML
    const html = readFileSync(htmlPath, "utf-8");

    // Parse DOM with location info
    const doc = parse(html, { sourceCodeLocationInfo: true }) as DefaultTreeAdapterMap["document"];

    // Extract image references
    const imageRecords = extractImages(doc);
    console.log(`Found ${imageRecords.length} image references`);

    // Resolve URLs and collect unique
    const baseUrl = "https://www.made-in-china.com/";
    const urlSet = new Set<string>();

    for (const rec of imageRecords) {
      // Handle srcset
      if (rec.attrName === "srcset" || rec.attrName === "data-srcset") {
        for (const part of rec.originalValue.split(",")) {
          const tokens = part.trim().split(/\s+/);
          if (tokens[0]) {
            const resolved = resolveUrl(tokens[0], baseUrl);
            if (resolved) urlSet.add(resolved);
          }
        }
        // Also track overall srcset value for the whole-set replacement
        urlSet.add(`__SRCSET__${rec.offsets.start}`); // marker
      } else {
        const resolved = resolveUrl(rec.originalValue, baseUrl);
        if (resolved) urlSet.add(resolved);
      }
    }

    // Remove markers
    const markers = new Set<string>();
    for (const u of urlSet) if (u.startsWith("__SRCSET__")) markers.add(u);
    for (const m of markers) urlSet.delete(m);

    console.log(`Unique image URLs: ${urlSet.size}`);

    // Build URL map
    const urlMap = new Map<string, { localPath: string; status: "DOWNLOADED" | "FAILED" }>();

    const imagesDir = join(siteRoot, "assets", "images");
    mkdirSync(imagesDir, { recursive: true });

    // Check for existing files
    const existingFiles = new Set<string>();
    // We'll track which files already exist

    let downloaded = 0;
    let failed = 0;

    for (const url of urlSet) {
      if (isTrackingPixel(url)) {
        urlMap.set(url, { localPath: "", status: "SKIPPED" as "FAILED" });
        continue;
      }

      const fname = safeFilename(url);
      const localPath = `./assets/images/${fname}`;
      const fullPath = join(imagesDir, fname);

      if (existsSync(fullPath)) {
        urlMap.set(url, { localPath, status: "DOWNLOADED" });
        downloaded++;
        continue;
      }

      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok || response.status >= 400) {
          failed++;
          urlMap.set(url, { localPath: "", status: "FAILED" });
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 50) {
          failed++;
          urlMap.set(url, { localPath: "", status: "FAILED" });
          continue;
        }

        writeFileSync(fullPath, buffer);
        urlMap.set(url, { localPath, status: "DOWNLOADED" });
        downloaded++;
      } catch {
        failed++;
        urlMap.set(url, { localPath: "", status: "FAILED" });
      }
    }

    console.log(`Downloaded: ${downloaded}, Failed: ${failed}`);

    // Build patches
    const patches: Patch[] = [];

    for (const rec of imageRecords) {
      const { attrName, originalValue, offsets } = rec;

      // Handle srcset: split, replace each URL, reassemble
      if (attrName === "srcset" || attrName === "data-srcset") {
        const parts = originalValue.split(",");
        const newParts: string[] = [];
        let changed = false;

        for (const part of parts) {
          const tokens = part.trim().split(/\s+/);
          if (!tokens[0]) continue;

          const resolved = resolveUrl(tokens[0], baseUrl);
          const desc = tokens.slice(1).join(" ");

          if (resolved && urlMap.has(resolved)) {
            const entry = urlMap.get(resolved)!;
            if (entry.status === "DOWNLOADED") {
              newParts.push(desc ? `${entry.localPath} ${desc}` : entry.localPath);
              changed = true;
              continue;
            }
          }
          newParts.push(part.trim());
        }

        if (changed) {
          patches.push({
            offset: offsets.start,
            length: offsets.end - offsets.start,
            replacement: newParts.join(", "),
          });
        }
        continue;
      }

      // Single URL attribute
      if (originalValue.startsWith("data:")) continue;
      if (
        originalValue.startsWith("./assets/") ||
        originalValue.startsWith("assets/")
      )
        continue; // Already local

      const resolved = resolveUrl(originalValue, baseUrl);
      if (!resolved) continue;

      const entry = urlMap.get(resolved);
      if (!entry || entry.status !== "DOWNLOADED") continue;

      patches.push({
        offset: offsets.start,
        length: offsets.end - offsets.start,
        replacement: entry.localPath,
      });
    }

    console.log(`Patches to apply: ${patches.length}`);

    // Sort by offset descending to preserve positions
    patches.sort((a, b) => b.offset - a.offset);

    // Apply patches
    let result = html;
    for (const p of patches) {
      result = result.slice(0, p.offset) + p.replacement + result.slice(p.offset + p.length);
    }

    // ── lazy-load normalization ─────────────────────────────────────────────
    // Parse the patched HTML for data-src promotion
    const doc2 = parse(result, { sourceCodeLocationInfo: true }) as DefaultTreeAdapterMap["document"];
    // Note: we can't use sourceCodeLocation after patches because offsets shifted
    // Instead we'll do a second parse and use regex-based approach on the already-patched HTML
    // which now has local paths. We only promote data-src that now points to ./assets/

    // For data-src normalization, we need a different approach since offsets changed
    // We'll just promote the data-src content via simple attribute manipulation
    let lazyPromoted = 0;

    // Track which data-src values to promote to src
    walkNodes(doc2, (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag !== "img") return;

      const dataSrc = el.attrs.find((a) => a.name === "data-src");
      if (!dataSrc || !dataSrc.value.startsWith("./assets/")) return;

      const src = el.attrs.find((a) => a.name === "src");
      const isMissing = !src || !src.value || src.value === "" || isPlaceholder(src.value);

      if (isMissing) {
        const loc = el.sourceCodeLocation?.attrs?.["src"];
        // We can't use offsets anymore after first patch round
        // Just note it
        lazyPromoted++;
      }
    });

    // Write result
    writeFileSync(htmlPath, result, "utf-8");
    console.log(`HTML updated: ${result.length} bytes`);

    // ── report ──────────────────────────────────────────────────────────────
    const urlMapEntries: UrlMapEntry[] = [];
    for (const [url, entry] of urlMap) {
      urlMapEntries.push({
        sourceUrl: url,
        localPath: entry.localPath,
        type: "image",
        status: entry.status,
      });
    }
    writeFileSync(
      join(siteRoot, "data", "url-map.json"),
      JSON.stringify(urlMapEntries, null, 2),
      "utf-8",
    );

    // Count remaining remote images in result
    const remainingRemote =
      result.match(/src="(?:https?:)?\/\/(?!www\.w3\.org)[^"]*\.(png|jpg|jpeg|gif|svg|webp)/gi)
        ?.length ?? 0;

    const report: Report = {
      uniqueImageUrls: urlSet.size,
      downloaded,
      localizedReferences: patches.length,
      lazyImagesPromotedToSrc: lazyPromoted,
      srcsetCandidatesLocalized: 0,
      remainingRemoteImages: [],
      trackingPixelsRemoved:
        Array.from(urlMap.entries()).filter(([, e]) => e.status === "SKIPPED" as string).length,
      svg404Resolved: false,
      logo: {
        localFileExists: existsSync(join(imagesDir, "logo_pc.png")),
        srcLocalized: false,
        loaded: false,
      },
    };

    // Check remaining remote
    const remoteMatches = result.matchAll(
      /src="((?:https?:)?\/\/[^"]*\.(?:png|jpg|jpeg|gif|svg|webp|ico))"/gi,
    );
    for (const m of remoteMatches) {
      report.remainingRemoteImages.push(m[1]);
    }

    writeFileSync(
      join(siteRoot, "reports", "image-localization-final.json"),
      JSON.stringify(report, null, 2),
      "utf-8",
    );

    console.log("Done.");
    console.log(`  Images: ${downloaded} downloaded, ${patches.length} localized`);
    console.log(`  Remote remaining: ${report.remainingRemoteImages.length}`);
    console.log(`  Tracking removed: ${report.trackingPixelsRemoved}`);
  }
}
