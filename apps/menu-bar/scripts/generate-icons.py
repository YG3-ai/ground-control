#!/usr/bin/env python3
"""Generate Ground Control icons (canonical app artwork + Lucide menu-bar template)."""
from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "Resources"
ICONSET = RES / "AppIcon.iconset"
APP_ICON_SOURCE = RES / "AppIconSource.jpg"
MIN_APP_ICON_SOURCE_PX = 1024
LUCIDE = ROOT / "assets" / "lucide"
RSVG = "/opt/homebrew/bin/rsvg-convert"

_app_icon_source: Image.Image | None = None


def load_app_icon_source() -> Image.Image:
    global _app_icon_source
    if _app_icon_source is not None:
        return _app_icon_source
    if not APP_ICON_SOURCE.is_file():
        raise FileNotFoundError(
            f"Canonical app icon source missing: {APP_ICON_SOURCE}"
        )
    img = Image.open(APP_ICON_SOURCE)
    width, height = img.size
    if width != height:
        raise ValueError(
            f"App icon source must be square; got {width}x{height} at {APP_ICON_SOURCE}"
        )
    if width < MIN_APP_ICON_SOURCE_PX or height < MIN_APP_ICON_SOURCE_PX:
        raise ValueError(
            f"App icon source too small ({width}x{height}); "
            f"need at least {MIN_APP_ICON_SOURCE_PX}x{MIN_APP_ICON_SOURCE_PX}"
        )
    _app_icon_source = img.convert("RGBA")
    return _app_icon_source


def load_svg_rgba(path: Path, width: int, stroke: str, stroke_width: float = 2.2) -> Image.Image:
    raw = path.read_text()
    raw = raw.replace('stroke="currentColor"', f'stroke="{stroke}"')
    raw = raw.replace('width="24"', f'width="{width}"')
    raw = raw.replace('height="24"', f'height="{width}"')
    if "stroke-width" not in raw:
        raw = raw.replace("<svg", f'<svg stroke-width="{stroke_width}"', 1)
    proc = subprocess.run(
        [RSVG, "-w", str(width), "-h", str(width)],
        input=raw.encode(),
        capture_output=True,
        check=True,
    )
    return Image.open(io.BytesIO(proc.stdout)).convert("RGBA")


def paste_center(base: Image.Image, layer: Image.Image, y_offset: int = 0) -> None:
    x = (base.width - layer.width) // 2
    y = (base.height - layer.height) // 2 + y_offset
    base.alpha_composite(layer, (x, y))


def compose_app_icon(size: int) -> Image.Image:
    source = load_app_icon_source()
    return source.resize((size, size), Image.LANCZOS)


def compose_menu_bar_icon(size: int) -> Image.Image:
    """Black template silhouette for macOS menu bar (alpha = ink)."""
    shield_px = max(size, int(size * 0.88))
    shield = load_svg_rgba(LUCIDE / "shield-check.svg", shield_px, "#ffffff", 2.8)
    zap_px = max(8, int(size * 0.34))
    zap = load_svg_rgba(LUCIDE / "zap.svg", zap_px, "#ffffff", 2.8)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    paste_center(canvas, shield, y_offset=-1)
    paste_center(canvas, zap, y_offset=int(size * 0.06))
    gray = canvas.convert("L")
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # macOS template icons: black pixels with alpha defining the shape
    out.paste((0, 0, 0, 255), mask=gray)
    if max(gray.getdata()) == 0:
        raise RuntimeError(f"menu bar icon {size}px rendered empty — check rsvg/lucide assets")
    return out


def write_iconset() -> None:
    ICONSET.mkdir(parents=True, exist_ok=True)
    mapping = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for name, px in mapping.items():
        compose_app_icon(px).save(ICONSET / name, optimize=True)

    icns_path = RES / "AppIcon.icns"
    subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET), "-o", str(icns_path)],
        check=True,
    )


def write_menu_bar_icons() -> None:
    RES.mkdir(parents=True, exist_ok=True)
    compose_menu_bar_icon(18).save(RES / "MenuBarIcon.png")
    compose_menu_bar_icon(36).save(RES / "MenuBarIcon@2x.png")


def main() -> int:
    try:
        load_app_icon_source()
    except (FileNotFoundError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    for name in ("shield-check.svg", "brain-circuit.svg", "zap.svg"):
        if not (LUCIDE / name).exists():
            print(f"Missing {LUCIDE / name}", file=sys.stderr)
            return 1
    write_iconset()
    write_menu_bar_icons()
    print(f"Wrote {RES / 'AppIcon.icns'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
