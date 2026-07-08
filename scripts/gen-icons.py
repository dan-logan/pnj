#!/usr/bin/env python3
"""Generate PWA icons for Pegs and Jokers.

Design: a dark rounded tile with a circular board "track" and the four
player-colour pegs (Yellow, Blue, Pink, Green) sitting on it, plus a bright
centre peg. Rendered at 4x and downsampled for crisp edges.
"""
import math
from PIL import Image, ImageDraw

BG_TOP = (30, 41, 59)      # slate-800
BG_BOT = (15, 23, 42)      # slate-900
TRACK = (51, 65, 85)       # slate-600
PEGS = [
    (245, 158, 11),   # Yellow  #F59E0B
    (59, 130, 246),   # Blue    #3B82F6
    (236, 72, 153),   # Pink    #EC4899
    (16, 185, 129),   # Green   #10B981
]

SS = 4  # supersample factor


def vgradient(size, top, bot):
    base = Image.new("RGB", (1, size), 0)
    for y in range(size):
        t = y / (size - 1)
        base.putpixel((0, y), tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return base.resize((size, size))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_icon(size, maskable=False):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    bg = vgradient(S, BG_TOP, BG_BOT).convert("RGBA")

    if maskable:
        # Full-bleed background so the platform can crop to any shape.
        img.paste(bg, (0, 0))
        content_scale = 0.56  # keep the motif inside the maskable safe circle
    else:
        radius = int(S * 0.22)
        mask = rounded_mask(S, radius)
        img.paste(bg, (0, 0), mask)
        content_scale = 0.78

    d = ImageDraw.Draw(img)
    cx = cy = S / 2
    track_r = S * content_scale / 2
    peg_r = S * 0.088
    ring_w = int(S * 0.035)

    # Board track ring
    d.ellipse([cx - track_r, cy - track_r, cx + track_r, cy + track_r],
              outline=TRACK, width=ring_w)

    # Four pegs on the ring at N, E, S, W
    for i, color in enumerate(PEGS):
        ang = -math.pi / 2 + i * math.pi / 2
        px = cx + track_r * math.cos(ang)
        py = cy + track_r * math.sin(ang)
        # subtle dark rim for contrast
        d.ellipse([px - peg_r * 1.12, py - peg_r * 1.12, px + peg_r * 1.12, py + peg_r * 1.12],
                  fill=BG_BOT)
        d.ellipse([px - peg_r, py - peg_r, px + peg_r, py + peg_r], fill=color)
        # highlight
        hl = peg_r * 0.34
        d.ellipse([px - peg_r * 0.4 - hl, py - peg_r * 0.4 - hl,
                   px - peg_r * 0.4 + hl, py - peg_r * 0.4 + hl],
                  fill=(255, 255, 255, 130))

    # Bright centre peg (the player)
    c_r = S * 0.14
    d.ellipse([cx - c_r * 1.1, cy - c_r * 1.1, cx + c_r * 1.1, cy + c_r * 1.1], fill=BG_BOT)
    d.ellipse([cx - c_r, cy - c_r, cx + c_r, cy + c_r], fill=PEGS[0])
    hl = c_r * 0.36
    d.ellipse([cx - c_r * 0.4 - hl, cy - c_r * 0.4 - hl,
               cx - c_r * 0.4 + hl, cy - c_r * 0.4 + hl], fill=(255, 255, 255, 150))

    return img.resize((size, size), Image.LANCZOS)


import os
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
os.makedirs(OUT, exist_ok=True)

draw_icon(192).save(f"{OUT}/pwa-192x192.png")
draw_icon(512).save(f"{OUT}/pwa-512x512.png")
draw_icon(512, maskable=True).save(f"{OUT}/pwa-maskable-512x512.png")
draw_icon(180).save(f"{OUT}/apple-touch-icon.png")
draw_icon(32).save(f"{OUT}/favicon-32x32.png")
draw_icon(64).save(f"{OUT}/favicon.png")
print("icons written to", OUT)
