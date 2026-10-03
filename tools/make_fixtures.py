"""Generates test images (each with a unique size) and the long-page fixture."""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
IMG = ROOT / "img"


def pattern(w: int, h: int, hue: int, label: str, alpha: bool = False) -> Image.Image:
    """Detailed gradient + XOR texture + grid so JPEG compression has real work to do."""
    x = np.arange(w, dtype=np.int64)[None, :]
    y = np.arange(h, dtype=np.int64)[:, None]
    r = (x * 255 // max(1, w - 1) + hue) % 256 + 0 * y
    g = (y * 255 // max(1, h - 1) + hue * 2) % 256 + 0 * x
    b = (x ^ y) & 0xFF
    chans = [r, g, b]
    if alpha:
        chans.append(np.where(((x // 64) + (y // 64)) % 2 == 0, 255, 96) + 0 * y + 0 * x)
    arr = np.stack(chans, axis=-1).astype(np.uint8)
    img = Image.fromarray(arr, "RGBA" if alpha else "RGB")
    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255) if alpha else (255, 255, 255)
    step = max(16, w // 40)
    for gx in range(0, w, step):
        d.line([(gx, 0), (gx, h)], fill=white, width=1)
    for gy in range(0, h, step):
        d.line([(0, gy), (w, gy)], fill=white, width=1)
    d.rectangle([w // 10, h // 10, w // 10 + max(40, w // 5), h // 10 + max(20, h // 12)], fill=(0, 0, 0))
    d.text((w // 10 + 6, h // 10 + 4), f"{label} {w}x{h}", fill=white)
    return img


def save(img: Image.Image, name: str, **kw) -> None:
    path = IMG / name
    if path.exists():
        return
    img.save(path, **kw)
    print("wrote", path.relative_to(ROOT))


def main() -> None:
    IMG.mkdir(parents=True, exist_ok=True)
    save(pattern(4000, 3000, 10, "big"), "big.jpg", quality=90)
    save(pattern(1600, 1200, 60, "alpha", alpha=True), "alpha.png")
    save(pattern(2400, 1600, 120, "webp"), "photo.webp", quality=90)
    for w in (400, 800, 1600, 3200):
        save(pattern(w, w * 2 // 3, w % 256, f"srcset{w}"), f"photo-{w}.jpg", quality=88)
    for d, w in ((1, 200), (2, 400), (3, 600)):
        save(pattern(w, w, 30 * d, f"x{d}"), f"icon@{d}x.png")
    save(pattern(800, 500, 200, "pic"), "pic-800.jpg", quality=88)
    save(pattern(1200, 750, 210, "picwebp"), "pic-1200.webp", quality=88)
    save(pattern(2400, 1500, 220, "picwebp"), "pic-2400.webp", quality=88)
    save(pattern(1000, 500, 90, "bg1x"), "bg@1x.jpg", quality=88)
    save(pattern(2000, 1000, 95, "bg2x"), "bg@2x.jpg", quality=88)
    save(pattern(2000, 1500, 150, "lazy"), "lazy.jpg", quality=88)
    save(pattern(60, 45, 150, "lqip"), "lazy-lqip.jpg", quality=60)
    save(pattern(300, 200, 170, "small"), "thumb.jpg", quality=85)
    write_long_page()


def write_long_page() -> None:
    path = ROOT / "long.html"
    blocks = []
    for i in range(200):
        blocks.append(
            f'<section><h2>Section {i}</h2><p>LONGTOK{i} Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
            f'Integer posuere erat a ante venenatis dapibus posuere velit aliquet.</p>'
            f'<img src="img/thumb.jpg?{i}" width="300" height="100" alt=""></section>'
        )
    html = (
        "<!doctype html><meta charset=utf-8><title>Long page</title>"
        "<style>body{font:16px/1.5 Georgia,serif;margin:0 auto;max-width:900px;padding:20px}"
        "section{height:130px;overflow:hidden;border-bottom:1px solid #ddd}</style>"
        "<h1>Long page</h1>" + "".join(blocks) + "<p>LONGEND</p>"
    )
    path.write_text(html)
    print("wrote", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
