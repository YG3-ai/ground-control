#!/usr/bin/env node
/**
 * Encode world live tiers from fixtures master (not served).
 * Usage: node scripts/encode-world-live.mjs [path-to-master.mp4]
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const masterDefault = join(root, "fixtures/world-live-master/world-live-source-4k.mp4");
const master = process.argv[2] || masterDefault;
const outDir = join(root, "packages/relay/src/assets/life-mirror");
const workDir = join(root, "fixtures/world-live-master/work");
const FADE = 0.45;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function probeDuration(path) {
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { encoding: "utf8" },
  );
  return parseFloat(r.stdout.trim());
}

if (!existsSync(master)) {
  console.error("missing master:", master);
  process.exit(1);
}

mkdirSync(workDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const dur = probeDuration(master);
const trimEnd = Math.max(0.5, dur - FADE);
const xfadeOffset = Math.max(0, trimEnd - FADE);
const headLen = FADE;
const looped = join(workDir, "world-live-looped-4k.mp4");

console.log("master", master, "dur", dur, "→ looped", looped);

run("ffmpeg", [
  "-y",
  "-i",
  master,
  "-an",
  "-filter_complex",
  `[0:v]fps=24,trim=0:${dur},setpts=PTS-STARTPTS,split=2[main][aux];` +
    `[main]trim=end=${trimEnd},setpts=PTS-STARTPTS[body];` +
    `[aux]trim=end=${headLen},fps=24,settb=1/24,setpts=PTS-STARTPTS[head];` +
    `[aux]trim=start=${trimEnd},fps=24,settb=1/24,setpts=PTS-STARTPTS[tail];` +
    `[tail][head]xfade=transition=fade:duration=${FADE}:offset=0[x];` +
    `[body][x]concat=n=2:v=1:a=0,format=yuv420p[v]`,
  "-map",
  "[v]",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "18",
  "-movflags",
  "+faststart",
  looped,
]);

/** width, height, crf, maxrate (k), outfile */
const tiers = [
  [3840, 2160, 26, 14000, "world-live-4k.mp4"],
  [2560, 1440, 27, 8000, "world-live-1440.mp4"],
  [1920, 1080, 28, 4500, "world-live-1080.mp4"],
  [1280, 720, 28, 2200, "world-live.mp4"],
];

const report = { master: { path: master, bytes: statSync(master).size, dur }, tiers: [] };

for (const [w, h, crf, maxK, name] of tiers) {
  const out = join(outDir, name);
  const maxrate = `${maxK}k`;
  const bufsize = `${maxK * 2}k`;
  run("ffmpeg", [
    "-y",
    "-i",
    looped,
    "-an",
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    String(crf),
    "-maxrate",
    maxrate,
    "-bufsize",
    bufsize,
    "-movflags",
    "+faststart",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
  const buf = readFileSync(out);
  report.tiers.push({
    file: name,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    w,
    h,
    crf,
    maxrate,
  });
  console.log(name, buf.length, "bytes");
}

const reportPath = join(workDir, "encode-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log("wrote", reportPath);
