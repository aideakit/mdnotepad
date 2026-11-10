"""Draws the toolbar icon of the plugin (letters "mn" on a rounded blue square) into resources/mdnotepad.ico.
Run: python tools/make_icon.py   (needs Pillow). Sizes are rendered 8x larger and scaled down for smooth edges."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 20, 24, 32, 40, 48, 64]
BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)
FONT = Path(r"C:\Windows\Fonts\arialbd.ttf")
SCALE = 8


def draw(size: int) -> Image.Image:
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    margin = max(1, round(size * 0.04)) * SCALE
    d.rounded_rectangle([margin, margin, big - margin - 1, big - margin - 1], radius=int(big * 0.2), fill=BLUE)
    font = ImageFont.truetype(str(FONT), int(big * 0.62))
    box = d.textbbox((0, 0), "mn", font=font)
    x = (big - (box[2] - box[0])) // 2 - box[0]
    y = (big - (box[3] - box[1])) // 2 - box[1]
    d.text((x, y), "mn", font=font, fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


out = Path(__file__).resolve().parent.parent / "resources" / "mdnotepad.ico"
images = [draw(s) for s in SIZES]
images[-1].save(out, format="ICO", sizes=[(s, s) for s in SIZES], append_images=images[:-1])
# a preview sheet next to the icon is useful when tuning the design
sheet = Image.new("RGBA", (sum(SIZES) + 10 * len(SIZES), 64), (240, 240, 240, 255))
x = 5
for im in images:
    sheet.paste(im, (x, 0), im)
    x += im.width + 10
sheet.resize((sheet.width * 3, sheet.height * 3), Image.NEAREST).save(out.with_suffix(".preview.png"))
print("written", out, out.stat().st_size, "bytes")
