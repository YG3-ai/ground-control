#!/usr/bin/env python3
"""Derive relay/PWA PNGs and favicon from the canonical Ground Control app icon."""
from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SOURCE = (
    ROOT
    / "apps"
    / "menu-bar"
    / "Resources"
    / "AppIcon.iconset"
    / "icon_512x512@2x.png"
)
OUT_ROOT = Path(__file__).resolve().parents[1] / "src" / "icons"

SIZES = {
    "icon-32.png": 32,
    "icon-180.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
}


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def write_png(img: Image.Image, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, format="PNG", optimize=True)


def write_favicon_ico(images: list[tuple[int, Image.Image]], dest: Path) -> None:
    """Minimal ICO with one or more PNG-embedded entries (Windows / browsers)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    entries: list[bytes] = []
    offset = 6 + 16 * len(images)
    dir_entries = bytearray()
    for size, img in images:
        png = _png_bytes(img)
        w = size if size < 256 else 0
        h = size if size < 256 else 0
        dir_entries += struct.pack(
            "<BBBBHHII",
            w,
            h,
            0,
            0,
            1,
            32,
            len(png),
            offset,
        )
        entries.append(png)
        offset += len(png)
    out = bytearray()
    out += struct.pack("<HHH", 0, 1, len(images))
    out += dir_entries
    for blob in entries:
        out += blob
    dest.write_bytes(bytes(out))


def _png_bytes(img: Image.Image) -> bytes:
    from io import BytesIO

    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f"Canonical app icon missing: {SOURCE}")
    version = file_hash(SOURCE)
    out_dir = OUT_ROOT / version
    out_dir.mkdir(parents=True, exist_ok=True)

    source = Image.open(SOURCE).convert("RGBA")
    if source.width != source.height:
        raise SystemExit(f"App icon must be square; got {source.width}x{source.height}")

    favicon_sizes: list[tuple[int, Image.Image]] = []
    for name, px in sorted(SIZES.items(), key=lambda x: x[1]):
        resized = source.resize((px, px), Image.LANCZOS)
        write_png(resized, out_dir / name)
        if px in (16, 32):
            favicon_sizes.append((px, resized))

    if not favicon_sizes:
        favicon_sizes = [
            (16, source.resize((16, 16), Image.LANCZOS)),
            (32, source.resize((32, 32), Image.LANCZOS)),
        ]
    write_favicon_ico(favicon_sizes, out_dir / "favicon.ico")

    meta = {
        "version": version,
        "source": str(SOURCE.relative_to(ROOT)),
        "sizes": {k: v for k, v in SIZES.items()},
    }
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    (OUT_ROOT / "icon-set-version.json").write_text(
        json.dumps(meta, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"ground-pwa-icons: {version} -> {out_dir.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
