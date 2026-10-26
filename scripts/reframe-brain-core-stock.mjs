#!/usr/bin/env node
/**
 * Tight-reframe brain-core-stock.mp4 to content bounds (+5% breathing room).
 * Scans all frames for non-black pixels; encodes derivative for HUD.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages/relay/src/assets/life-mirror");
const archiveMp4 = join(dir, "brain-core-stock-letterbox.mp4");
const src = join(dir, existsSync(archiveMp4) ? "brain-core-stock-letterbox.mp4" : "brain-core-stock.mp4");
/** Offline derivative only — never overwrite live brain-core-stock.* */
const outMp4 = join(dir, "brain-core-stock-tight.mp4");
const outPoster = join(dir, "brain-core-stock-tight-poster.webp");
const outPosterPng = join(dir, "brain-core-stock-tight-poster.png");

function probeSize() {
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,nb_frames",
      "-of",
      "json",
      src,
    ],
    { encoding: "utf8" },
  );
  const j = JSON.parse(r.stdout);
  const s = j.streams[0];
  return { W: s.width, H: s.height, frames: Number(s.nb_frames) || 240 };
}

function unionCrop({ W, H, frames }) {
  let minX = W;
  let minY = H;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < frames; i++) {
    const t = i / 24;
    const r = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-ss",
        String(t),
        "-i",
        src,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { encoding: "buffer", maxBuffer: W * H * 3 + 1e6 },
    );
    if (r.status !== 0) continue;
    const buf = r.stdout;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3;
        const R = buf[o];
        const G = buf[o + 1];
        const B = buf[o + 2];
        if (Math.max(R, G, B) < 18) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const padX = Math.round(cw * 0.05);
  const padY = Math.round(ch * 0.05);
  let x = Math.max(0, minX - padX);
  let y = Math.max(0, minY - padY);
  let w = Math.min(W - x, cw + 2 * padX);
  let h = Math.min(H - y, ch + 2 * padY);
  w -= w % 2;
  h -= h % 2;
  if (x % 2) x -= 1;
  if (y % 2) y -= 1;
  return { minX, minY, maxX, maxY, x, y, w, h };
}

function encode(crop) {
  const vf = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
  const enc = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-i",
      src,
      "-vf",
      vf,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "20",
      "-preset",
      "medium",
      "-movflags",
      "+faststart",
      "-an",
      outMp4,
    ],
    { encoding: "utf8" },
  );
  if (enc.status !== 0) {
    console.error(enc.stderr);
    process.exit(1);
  }
  const poster = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-ss",
      "2",
      "-i",
      outMp4,
      "-frames:v",
      "1",
      outPosterPng,
    ],
    { encoding: "utf8" },
  );
  if (poster.status !== 0) {
    console.error(poster.stderr);
    process.exit(1);
  }
  const webp = spawnSync("cwebp", ["-q", "82", outPosterPng, "-o", outPoster], {
    encoding: "utf8",
  });
  if (webp.status !== 0) {
    console.error(webp.stderr);
    process.exit(1);
  }
}

function verifyTight(crop) {
  const { W, H } = probeSize();
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      outMp4,
    ],
    { encoding: "utf8" },
  );
  const out = JSON.parse(r.stdout).streams[0];
  const checks = [];
  for (const t of [0, 1.2, 2.5, 4, 6.2, 8.5, 9.8]) {
    const raw = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-ss",
        String(t),
        "-i",
        outMp4,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { encoding: "buffer", maxBuffer: out.width * out.height * 3 + 1e6 },
    );
    let minX = out.width;
    let minY = out.height;
    let maxX = 0;
    let maxY = 0;
    const buf = raw.stdout;
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const o = (y * out.width + x) * 3;
        if (Math.max(buf[o], buf[o + 1], buf[o + 2]) < 18) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const marginL = minX;
    const marginR = out.width - 1 - maxX;
    const marginT = minY;
    const marginB = out.height - 1 - maxY;
    const minMargin = Math.min(marginL, marginR, marginT, marginB);
    const fillW = (maxX - minX + 1) / out.width;
    const fillH = (maxY - minY + 1) / out.height;
    checks.push({ t, minMargin, fillW, fillH });
  }
  return { source: { W, H }, crop, output: out, checks };
}

const size = probeSize();
const crop = unionCrop(size);
console.log("Crop:", crop);
if (!existsSync(archiveMp4)) {
  copyFileSync(src, archiveMp4);
  console.log("Archived letterbox source to", archiveMp4);
}
encode(crop);
const report = verifyTight(crop);
console.log(JSON.stringify(report, null, 2));
  const bad = report.checks.filter((c) => c.minMargin < 6 || c.fillW < 0.8 || c.fillH < 0.72);
if (bad.length) {
  console.error("Tight frame verification failed", bad);
  process.exit(1);
}
