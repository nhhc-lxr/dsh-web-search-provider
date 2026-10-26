"""Render the storefront tile for dsh-web-search-provider (256x256 PNG)."""

import os
from PIL import Image, ImageDraw

SIZE = 256
SCALE = 4  # supersample, then downscale for clean edges
W = SIZE * SCALE

top = (22, 50, 92)
bottom = (47, 127, 212)

image = Image.new("RGBA", (W, W), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

# rounded tile with a vertical gradient
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=56 * SCALE // 4 * 4, fill=255)
gradient = Image.new("RGBA", (W, W))
gdraw = ImageDraw.Draw(gradient)
for y in range(W):
    t = y / (W - 1)
    gdraw.line(
        [(0, y), (W, y)],
        fill=(
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
            255,
        ),
    )
image.paste(gradient, (0, 0), mask)
draw = ImageDraw.Draw(image)

def s(*values):
    return [round(value * SCALE) for value in values]

# document
draw.rounded_rectangle(s(70, 46, 158, 170), radius=10 * SCALE, fill=(234, 243, 255, 245))
draw.polygon(
    [
        (132 * SCALE, 46 * SCALE),
        (158 * SCALE, 72 * SCALE),
        (132 * SCALE, 72 * SCALE),
    ],
    fill=(169, 201, 238, 255),
)
for y, width in ((100, 62), (120, 62), (140, 40)):
    draw.rounded_rectangle(
        s(88, y, 88 + width, y + 7),
        radius=3 * SCALE,
        fill=(120, 152, 186, 255),
    )

# magnifier
ring = [146 * SCALE, 148 * SCALE, 214 * SCALE, 216 * SCALE]
draw.ellipse(ring, outline=(255, 209, 102, 255), width=15 * SCALE)
draw.line(
    [(203 * SCALE, 205 * SCALE), (231 * SCALE, 233 * SCALE)],
    fill=(255, 209, 102, 255),
    width=17 * SCALE,
)
draw.ellipse(
    [(203 - 8) * SCALE, (205 - 8) * SCALE, (203 + 8) * SCALE, (205 + 8) * SCALE],
    fill=(255, 209, 102, 255),
)

out = image.resize((SIZE, SIZE), Image.LANCZOS)
target = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
os.makedirs(target, exist_ok=True)
path = os.path.join(target, "icon-256.png")
out.save(path, "PNG", optimize=True)
print("wrote", path, os.path.getsize(path), "bytes")
