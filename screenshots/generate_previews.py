#!/usr/bin/env python3
"""Gera pré-visualizações da UI (popup e overlay sobre o vídeo) para o README.

Como não há engine de browser neste ambiente para capturar a extensão rodando,
estas imagens são representações fiéis desenhadas a partir do CSS real
(popup.css) e dos botões flutuantes. Usam apenas Pillow.

Uso:
    python3 screenshots/generate_previews.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))

# Paleta (espelha popup.css)
BG = (30, 30, 30)          # #1e1e1e
PANEL = (45, 45, 45)       # #2d2d2d
PANEL_BORDER = (61, 61, 61)  # #3d3d3d
BLUE = (59, 130, 246)      # #3b82f6
GREEN = (16, 185, 129)     # #10b981
WHITE = (255, 255, 255)
GRAY = (156, 163, 175)     # #9ca3af
LIGHT = (203, 213, 225)    # #cbd5e1


def load_font(size, bold=False):
    candidates = [
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def round_rect(draw, xy, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def center_text(draw, box, text, font, color):
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = box[0] + (box[2] - box[0] - w) / 2
    y = box[1] + (box[3] - box[1] - h) / 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=color)
    return w


def draw_pip_glyph(draw, cx, cy, s, color):
    # tela (contorno) + janela pequena (preenchida)
    o = s * 0.42
    round_rect(draw, [cx - o, cy - o * 0.8, cx + o, cy + o * 0.8],
               radius=s * 0.12, outline=color, width=max(1, int(s * 0.08)))
    r = s * 0.32
    round_rect(draw, [cx + o * 0.25, cy + o * 0.05, cx + o * 0.95, cy + o * 0.75],
               radius=s * 0.08, fill=color)


def draw_enhance_glyph(draw, cx, cy, s, color):
    # estrela de 4 pontas (sparkle)
    r = s * 0.5
    p1 = (cx, cy - r)
    p2 = (cx + r * 0.28, cy - r * 0.28)
    p3 = (cx + r, cy)
    p4 = (cx + r * 0.28, cy + r * 0.28)
    p5 = (cx, cy + r)
    p6 = (cx - r * 0.28, cy + r * 0.28)
    p7 = (cx - r, cy)
    p8 = (cx - r * 0.28, cy - r * 0.28)
    draw.polygon([p1, p2, p3, p4, p5, p6, p7, p8], fill=color)


def draw_download_glyph(draw, cx, cy, s, color):
    # seta para baixo + barra
    w = s * 0.5
    draw.polygon([(cx, cy + s * 0.1), (cx - w * 0.5, cy - s * 0.25),
                  (cx + w * 0.5, cy - s * 0.25)], fill=color)
    bar = s * 0.16
    draw.rectangle([cx - w * 0.6, cy + s * 0.2, cx + w * 0.6, cy + s * 0.2 + bar], fill=color)


def build_popup():
    W, H = 250, 430
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_title = load_font(15, bold=True)
    f_text = load_font(13)
    f_small = load_font(11)
    f_tiny = load_font(9)

    # Header
    round_rect(d, [64, 18, 96, 50], radius=6, fill=BLUE)
    draw_pip_glyph(d, 80, 34, 22, WHITE)
    d.text((104, 28), "Universal PiP", font=f_title, fill=WHITE)

    # Status box
    round_rect(d, [16, 66, 234, 110], radius=8, fill=PANEL, outline=PANEL_BORDER, width=1)
    center_text(d, [16, 66, 234, 110], "2 vídeo(s) detectado(s)", f_text, WHITE)

    # Toggle PiP button
    round_rect(d, [16, 120, 234, 160], radius=6, fill=BLUE)
    center_text(d, [16, 120, 234, 160], "Ativar PiP (Alt+P)", f_text, WHITE)

    # Enhance box
    round_rect(d, [16, 172, 234, 268], radius=8, fill=PANEL, outline=PANEL_BORDER, width=1)
    d.text((28, 184), "Realçar vídeo", font=f_text, fill=WHITE)
    # checkbox
    round_rect(d, [200, 182, 216, 198], radius=3, outline=BLUE, width=2)
    d.line([203, 190, 208, 195, 214, 184], fill=BLUE, width=2)
    d.text((28, 212), "Intensidade", font=f_text, fill=WHITE)
    # slider track + fill + knob
    d.rounded_rectangle([112, 220, 222, 224], radius=2, fill=BG)
    d.rounded_rectangle([112, 220, 167, 224], radius=2, fill=BLUE)
    d.ellipse([160, 214, 174, 228], fill=BLUE)
    center_text(d, [16, 236, 234, 260], "○ realce desligado", f_small, GRAY)

    # Download box
    round_rect(d, [16, 280, 234, 410], radius=8, fill=PANEL, outline=PANEL_BORDER, width=1)
    # thumbnails
    for i, x in enumerate([24, 90, 156]):
        round_rect(d, [x, 290, x + 60, 332], radius=6, fill=BG, outline=PANEL_BORDER, width=1)
        d.polygon([(x + 24, 302), (x + 14, 312), (x + 34, 312)], fill=GRAY)
        d.text((x + 4, 316), ["MP4", "HLS", "MP4"][i], font=f_tiny, fill=LIGHT)
    # download button
    round_rect(d, [24, 342, 226, 378], radius=6, fill=GREEN)
    center_text(d, [24, 342, 226, 378], "⬇ Baixar vídeo", f_text, WHITE)
    center_text(d, [24, 384, 226, 406], "Detectando fonte…", f_small, GRAY)

    # Footer
    d.text((16, 414), "Atalhos: Alt+P · by SaldanhaC3", font=f_tiny, fill=GRAY)
    return img


def build_overlay():
    W, H = 640, 360
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    # cena de vídeo (gradiente escuro)
    for y in range(H):
        t = y / H
        c = (int(11 + t * 20), int(16 + t * 26), int(32 + t * 40))
        d.line([(0, y), (W, y)], fill=c)
    # botão de play central
    d.polygon([(300, 150), (300, 210), (350, 180)], fill=(255, 255, 255, 220))

    # Três botões flutuantes (canto superior direito), como na extensão
    bw, bh = 38, 30
    gap = 8
    base_x = W - 20 - bw
    positions = [("pip", base_x), ("enh", base_x - (bw + gap)), ("dl", base_x - 2 * (bw + gap))]
    for kind, x in positions:
        round_rect(d, [x, 20, x + bw, 20 + bh], radius=4, fill=(0, 0, 0, 180))
        cx = x + bw / 2
        cy = 20 + bh / 2
        if kind == "pip":
            draw_pip_glyph(d, cx, cy, 18, WHITE)
        elif kind == "enh":
            draw_enhance_glyph(d, cx, cy, 16, WHITE)
        else:
            draw_download_glyph(d, cx, cy, 16, WHITE)

    d.text((20, H - 28), "Passe o mouse sobre o vídeo para revelar PiP, realce e download",
           font=load_font(13), fill=(255, 255, 255, 230))
    return img


def main():
    popup = build_popup()
    popup.save(os.path.join(BASE, "popup.png"))
    overlay = build_overlay()
    overlay.save(os.path.join(BASE, "overlay.png"))
    print("gerado: screenshots/popup.png", popup.size)
    print("gerado: screenshots/overlay.png", overlay.size)


if __name__ == "__main__":
    main()
