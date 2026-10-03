"""Draws the extension icon (blue tile, white page, download arrow) at 16-128 px."""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
S = 512  # draw large, then downsample for clean edges
BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)
FOLD = (191, 210, 250, 255)


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([16, 16, S - 16, S - 16], radius=110, fill=BLUE)

    # Page with a folded top-right corner.
    left, top, right, bottom, fold = 136, 92, 376, 420, 78
    d.polygon(
        [(left, top), (right - fold, top), (right, top + fold), (right, bottom), (left, bottom)],
        fill=WHITE,
    )
    d.polygon([(right - fold, top), (right - fold, top + fold), (right, top + fold)], fill=FOLD)

    # Download arrow.
    cx = (left + right) // 2
    d.rectangle([cx - 26, 170, cx + 26, 300], fill=BLUE)
    d.polygon([(cx - 76, 280), (cx + 76, 280), (cx, 360)], fill=BLUE)
    d.rectangle([cx - 80, 376, cx + 80, 396], fill=BLUE)
    return img


def main() -> None:
    OUT.mkdir(exist_ok=True)
    big = draw()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    print(f"wrote icons to {OUT}")


if __name__ == "__main__":
    main()
