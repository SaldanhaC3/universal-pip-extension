#!/usr/bin/env python3
"""Gera os ícones da extensão (16/48/128 px) a partir de um desenho vetorial.

Sem dependências de build: usa apenas Pillow. O glifo é desenhado de forma
proporcional a cada tamanho, para manter nitidez em 16px e 128px.

Uso:
    python3 icons/generate_icons.py
"""
import os
from PIL import Image, ImageDraw

BASE = os.path.dirname(os.path.abspath(__file__))
SIZE = 128  # espaço de desenho de referência

# Coordenadas no espaço de 128px (escaladas para cada tamanho de saída).
BG_MARGIN = 4
BG_RADIUS = 26
GLYPH_OUTLINE = (26, 34, 102, 92)   # retângulo grande (a "tela")
GLYPH_OUTLINE_R = 9
GLYPH_INSET = (66, 62, 100, 86)     # retângulo pequeno (a janela em PiP)
GLYPH_INSET_R = 5
STROKE_REF = 7                       # espessura do contorno na referência 128px

TOP = (59, 130, 246)    # #3b82f6
BOTTOM = (29, 78, 216)  # #1d4ed8
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def draw_icon(size):
    scale = size / SIZE
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Fundo: gradiente diagonal azul, recortado num quadrado arredondado.
    gradient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gpix = gradient.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            gpix[x, y] = lerp(TOP, BOTTOM, t) + (255,)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [c * scale for c in (BG_MARGIN, BG_MARGIN, SIZE - BG_MARGIN, SIZE - BG_MARGIN)],
        radius=int(BG_RADIUS * scale), fill=255)
    img.paste(gradient, (0, 0), mask)

    # Glifo de Picture-in-Picture (branco).
    d = ImageDraw.Draw(img)
    stroke = max(1, round(STROKE_REF * scale))
    d.rounded_rectangle([c * scale for c in GLYPH_OUTLINE], radius=int(GLYPH_OUTLINE_R * scale),
                        outline=WHITE, width=stroke)
    d.rounded_rectangle([c * scale for c in GLYPH_INSET], radius=int(GLYPH_INSET_R * scale),
                        fill=WHITE)
    return img


def main():
    for px in (16, 48, 128):
        out = os.path.join(BASE, f"icon{px}.png")
        draw_icon(px).save(out)
        print("gerado:", os.path.relpath(out, BASE))


if __name__ == "__main__":
    main()
