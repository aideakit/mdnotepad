"""Draws the toolbar icon of the plugin (white letters "mn" on a rounded blue square) into resources/mdnotepad.ico.
Run: python tools/make_icon.py   (needs Pillow).

Each size has its own hand-picked grid (stroke, gaps, letter height), so the strokes fall exactly on pixels and stay
sharp at 16 px; the shapes are drawn 8x larger and scaled down only to smooth the rounded corners."""
from pathlib import Path

from PIL import Image, ImageDraw

K = 8  # supersampling factor

# size: (stroke, gap between stems, gap between "m" and "n", letter height)
GRID = {
    16: (1, 2, 2, 7),
    20: (2, 2, 2, 9),
    24: (2, 2, 3, 11),
    32: (3, 3, 3, 14),
    40: (4, 3, 4, 18),
    48: (4, 4, 5, 21),
    64: (6, 5, 6, 28),
}
TOP = (64, 145, 255)      # gradient, top
BOTTOM = (29, 78, 216)    # gradient, bottom
BORDER = (23, 52, 140)    # 1 px outline: keeps the square visible on light and dark toolbars
WHITE = (255, 255, 255, 255)


def draw(size: int) -> Image.Image:
    stroke, gap, spacing, height = GRID[size]
    big = size * K
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = max(3, round(size * 0.22)) * K
    d.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=BORDER + (255,))
    fill = Image.new("RGBA", (big, big))
    fd = ImageDraw.Draw(fill)
    for y in range(big):
        t = y / (big - 1)
        fd.line([(0, y), (big, y)], fill=tuple(round(TOP[i] * (1 - t) + BOTTOM[i] * t) for i in range(3)) + (255,))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([K, K, big - K - 1, big - K - 1], radius=radius - K, fill=255)
    img.paste(fill, (0, 0), mask)

    def box(x0, y0, x1, y1):  # pixel units, end exclusive
        d.rectangle([x0 * K, y0 * K, x1 * K - 1, y1 * K - 1], fill=WHITE)

    def letter(x, stems):  # stems joined at the top by an arch with rounded outer corners
        right = x + stems * stroke + (stems - 1) * gap
        r = int(stroke * 1.6 * K) if size >= 24 else int(K * 0.9)
        d.rounded_rectangle([x * K, top * K, right * K - 1, (top + 2 * stroke) * K - 1 + r], radius=r, fill=WHITE)
        for i in range(stems):
            sx = x + i * (stroke + gap)
            box(sx, top + stroke, sx + stroke, top + height)
        return right

    width = (3 * stroke + 2 * gap) + spacing + (2 * stroke + gap)
    left = (size - width) // 2
    top = (size - height) // 2
    # the arch overdraws the inner gaps below the bar; cut them back out
    end_m = letter(left, 3)
    end_n = letter(end_m + spacing, 2)
    for x0, stems in ((left, 3), (end_m + spacing, 2)):
        for i in range(stems - 1):
            gx = x0 + i * (stroke + gap) + stroke
            bg = fill.crop((gx * K, (top + stroke) * K, (gx + gap) * K, (top + height) * K))
            img.paste(bg, (gx * K, (top + stroke) * K))
    assert end_n <= size - 1, size
    return img.resize((size, size), Image.LANCZOS)


root = Path(__file__).resolve().parent.parent
out = root / "resources" / "mdnotepad.ico"
sizes = sorted(GRID)
images = [draw(s) for s in sizes]
images[-1].save(out, format="ICO", sizes=[(s, s) for s in sizes], append_images=images[:-1])

# Preview sheet (ignored by git): every size on a light and on a dark toolbar colour, 1x and 4x.
row_w = sum(sizes) + 8 * (len(sizes) + 1)
sheet = Image.new("RGBA", (row_w, 2 * 72), (240, 240, 240, 255))
ImageDraw.Draw(sheet).rectangle([0, 72, row_w, 144], fill=(43, 43, 43, 255))
for row in (0, 1):
    x = 8
    for im in images:
        sheet.paste(im, (x, row * 72 + 4), im)
        x += im.width + 8
sheet.resize((sheet.width * 3, sheet.height * 3), Image.NEAREST).save(out.with_suffix(".preview.png"))
print("written", out, out.stat().st_size, "bytes")
