#!/usr/bin/env python3
"""Rebuilds the four PNGs of the app icon (dashboard/icons) from the brand's vector sources (docs/images/logo/luvebot-home-icon*.svg).

The browser rasterises each source big (1024: a headless Chrome window is never narrower than ~500 px, so a 180 px window renders at another size and crops), Pillow reduces it
to the iPhone Home Screen icon (180), the manifest's 192 and 512, and the maskable 512. Every PNG is opaque RGB, because iOS paints transparency black.
It measures what it made and fails when the mascot is not as big, or as safe, as the design says (the unit test holds the same numbers).

    python3 scripts/build_app_icons.py            (CHROME=/path/to/chrome to use another browser; needs Pillow)
"""
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
LOGO, ICONS = REPO / "docs/images/logo", REPO / "dashboard/icons"
# (source svg, side, output, what the mascot must be): `any` icons fill 80% of the width; the maskable one stays inside the circle of radius 40% (the spec's safe zone)
TARGETS = [("luvebot-home-icon.svg", 180, "apple-touch-icon.png", "any"), ("luvebot-home-icon.svg", 192, "icon-192.png", "any"),
           ("luvebot-home-icon.svg", 512, "icon-512.png", "any"), ("luvebot-home-icon-maskable.svg", 512, "icon-maskable-512.png", "maskable")]


def rasterise(svg: str, side: int = 1024) -> Image.Image:
    with tempfile.TemporaryDirectory() as tmp:   # a profile and an output of its own: two Chromes back to back share a lock otherwise
        out = Path(tmp) / "r.png"
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", f"--user-data-dir={tmp}/p",
                        f"--window-size={side},{side}", f"--screenshot={out}", f"file://{LOGO / svg}"], capture_output=True, timeout=120)
        if not out.exists():
            sys.exit(f"the browser made no picture of {svg}: is CHROME right?")
        im = Image.open(out).convert("RGB")
    if im.size != (side, side):
        sys.exit(f"{svg} came out {im.size}, not {side} x {side}")
    return im


def mascot(im: Image.Image):
    """(width as a fraction of the side, farthest pixel from the centre as a fraction of the side) of everything darker than the lightest background."""
    s, px = im.size[0], im.load()
    xs, far = [], 0.0
    for y in range(s):
        for x in range(s):
            r, g, b = px[x, y]
            if 0.299 * r + 0.587 * g + 0.114 * b < 204:
                xs.append(x)
                far = max(far, math.hypot(x + .5 - s / 2, y + .5 - s / 2))
    return (max(xs) - min(xs) + 1) / s, far / s


def main() -> None:
    big = {}
    for svg, side, name, kind in TARGETS:
        if svg not in big:
            big[svg] = rasterise(svg)
        im = big[svg].resize((side, side), Image.LANCZOS)
        width, far = mascot(im)
        ok = (0.78 <= width <= 0.84) if kind == "any" else (0.62 <= width <= 0.68 and far <= 0.40)
        print(f"{'ok  ' if ok else 'FAIL'} {name:<22} {side}x{side}  mascot {width:.1%} of the width, farthest pixel {far:.3f} of the side")
        if not ok:
            sys.exit(f"{name}: the mascot is not what the design says")
        im.save(ICONS / name, optimize=True)


if __name__ == "__main__":
    main()
