import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type IconSetMeta = {
  version: string;
  source?: string;
  sizes?: Record<string, number>;
};

const ICON_FILES = [
  "favicon.ico",
  "icon-32.png",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
] as const;

export type IconSetPaths = {
  version: string;
  rootDir: string;
  dir: string;
};

export function resolveIconSet(relayDir: string): IconSetPaths | null {
  const metaPath = join(relayDir, "icons", "icon-set-version.json");
  const fallbackMeta = join(relayDir, "..", "src", "icons", "icon-set-version.json");
  const chosen = existsSync(metaPath) ? metaPath : fallbackMeta;
  if (!existsSync(chosen)) return null;
  let meta: IconSetMeta;
  try {
    meta = JSON.parse(readFileSync(chosen, "utf8")) as IconSetMeta;
  } catch {
    return null;
  }
  const version = meta.version?.trim();
  if (!version) return null;
  const rootDir = join(chosen, "..");
  const dir = join(rootDir, version);
  if (!existsSync(dir)) return null;
  for (const file of ICON_FILES) {
    if (!existsSync(join(dir, file))) return null;
  }
  return { version, rootDir, dir };
}

export function iconPublicPath(version: string, file: string): string {
  return `/icons/${version}/${file}`;
}

export function buildWebManifest(version: string): string {
  const manifest = {
    name: "Ground Control",
    short_name: "Ground",
    description: "Missions and approvals on your Mac.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#faf9f7",
    theme_color: "#faf9f7",
    orientation: "portrait-primary",
    icons: [
      {
        src: iconPublicPath(version, "icon-192.png"),
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: iconPublicPath(version, "icon-512.png"),
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: iconPublicPath(version, "icon-512.png"),
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

const ICON_SET_PLACEHOLDER = "__GROUND_ICON_SET__";

export function applyBoardIconLinks(html: string, version: string): string {
  return html.replaceAll(ICON_SET_PLACEHOLDER, version);
}

export function etagForFile(path: string): string | undefined {
  try {
    const buf = readFileSync(path);
    return `"${createHash("sha256").update(buf).digest("hex").slice(0, 16)}"`;
  } catch {
    return undefined;
  }
}
