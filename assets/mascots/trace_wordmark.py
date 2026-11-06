# assets/mascots/trace_wordmark.py: vetoriza as letras do wordmark oficial (docs/images/logo/luvebot-wordmark-transparent.png).
# Fidelidade total ao original: o contorno sai do próprio PNG. A mediana tira o ruído das bordas, componentes pequenos
# (sujeira e furinhos) somem, o contorno é seguido pelas bordas dos pixels, suavizado, simplificado (RDP) e escrito em
# curvas com quinas curtas. Só usa PIL. Saída: wordmark-letters.json (path + caixas em pixels do PNG), lido pelo build.mjs.
# Uso: python3 assets/mascots/trace_wordmark.py

import json, math
from collections import deque
from pathlib import Path
from PIL import Image, ImageFilter

HERE = Path(__file__).parent
SRC = HERE / "../../docs/images/logo/luvebot-wordmark-transparent.png"
TEXT_X0 = 700          # à esquerda disso fica o mascote
MIN_AREA = 1500        # componente menor que isso é ruído (letras têm dezenas de milhares de px)
SIGMA, RDP_TOL, CORNER = 1.6, 0.35, 6.0  # suavização (px), tolerância de simplificação (px), raio máx. da quina (px)


def mask_of(img, x0, x1):
    a = img.split()[3].crop((x0, 0, x1, img.height)).filter(ImageFilter.MedianFilter(5))
    w, h = a.size
    px = a.load()
    return [[px[x, y] > 128 for x in range(w)] for y in range(h)], w, h


def clean(m, w, h):
    """Apaga ilhas pequenas de frente e tampa furos pequenos de fundo."""
    for target in (True, False):
        seen = [[False] * w for _ in range(h)]
        for y in range(h):
            for x in range(w):
                if seen[y][x] or m[y][x] != target:
                    continue
                comp, q, edge = [], deque([(x, y)]), False
                seen[y][x] = True
                while q:
                    cx, cy = q.popleft()
                    comp.append((cx, cy))
                    if cx in (0, w - 1) or cy in (0, h - 1):
                        edge = True
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                        if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and m[ny][nx] == target:
                            seen[ny][nx] = True
                            q.append((nx, ny))
                if len(comp) < MIN_AREA and not (edge and not target):
                    for cx, cy in comp:
                        m[cy][cx] = not target
    return m


def loops(m, w, h):
    """Arestas de pixel com a frente à esquerda, ligadas em laços fechados (cantos inteiros)."""
    f = lambda x, y: 0 <= x < w and 0 <= y < h and m[y][x]
    nxt = {}
    for y in range(h):
        for x in range(w):
            if not m[y][x]:
                continue
            if not f(x, y - 1): nxt.setdefault((x + 1, y), []).append((x, y))          # topo, indo para a esquerda
            if not f(x, y + 1): nxt.setdefault((x, y + 1), []).append((x + 1, y + 1))  # base, para a direita
            if not f(x - 1, y): nxt.setdefault((x, y), []).append((x, y + 1))          # esquerda, para baixo
            if not f(x + 1, y): nxt.setdefault((x + 1, y + 1), []).append((x + 1, y))  # direita, para cima
    out = []
    while nxt:
        start = next(iter(nxt))
        loop, p = [start], start
        while True:
            cand = nxt[p]
            q = cand.pop()
            if not cand:
                del nxt[p]
            if q == start:
                break
            loop.append(q)
            p = q
            if p not in nxt:
                break
        if len(loop) > 20:
            out.append(loop)
    return out


def smooth(pts, sigma):
    n, r = len(pts), int(3 * sigma)
    ker = [math.exp(-(i * i) / (2 * sigma * sigma)) for i in range(-r, r + 1)]
    s = sum(ker)
    return [(sum(ker[j + r] * pts[(i + j) % n][0] for j in range(-r, r + 1)) / s,
             sum(ker[j + r] * pts[(i + j) % n][1] for j in range(-r, r + 1)) / s) for i in range(n)]


def rdp(pts, tol):
    if len(pts) < 3:
        return pts
    (x0, y0), (x1, y1) = pts[0], pts[-1]
    dx, dy = x1 - x0, y1 - y0
    L = math.hypot(dx, dy) or 1e-9
    far, idx = 0, 0
    for i in range(1, len(pts) - 1):
        d = abs(dy * (pts[i][0] - x0) - dx * (pts[i][1] - y0)) / L
        if d > far:
            far, idx = d, i
    if far <= tol:
        return [pts[0], pts[-1]]
    return rdp(pts[: idx + 1], tol)[:-1] + rdp(pts[idx:], tol)


def closed_rdp(pts, tol):
    # parte o laço no ponto mais distante do primeiro, para o RDP funcionar em curva fechada
    k = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    return rdp(pts[: k + 1], tol)[:-1] + rdp(pts[k:] + [pts[0]], tol)[:-1]


def to_path(v, ox):
    """Cada vértice vira uma quadrática curta: reta nas partes retas, curva nas curvas, quina de no máximo CORNER px."""
    n, d = len(v), []
    fmt = lambda p: f"{p[0] + ox:.1f},{p[1]:.1f}"
    def toward(a, b, t):
        L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1e-9
        t = min(t, L / 2) / L
        return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    for i in range(n):
        p, a, b = v[i], v[i - 1], v[(i + 1) % n]
        s, e = toward(p, a, CORNER), toward(p, b, CORNER)
        d.append(("M" if i == 0 else "L") + fmt(s) + "Q" + fmt(p) + " " + fmt(e))
    return "".join(d) + "Z"


def main():
    img = Image.open(SRC).convert("RGBA")
    m, w, h = mask_of(img, TEXT_X0, img.width)
    m = clean(m, w, h)
    paths, xs, ys = [], [], []
    for lp in loops(m, w, h):
        v = closed_rdp(smooth(lp, SIGMA), RDP_TOL)
        paths.append(to_path(v, TEXT_X0))
        xs += [p[0] + TEXT_X0 for p in v]; ys += [p[1] for p in v]
    am = img.split()[3].crop((0, 0, TEXT_X0, img.height)).point(lambda a: 255 if a > 128 else 0).getbbox()
    out = {"source": "docs/images/logo/luvebot-wordmark-transparent.png", "size": [img.width, img.height],
           "d": "".join(paths), "letters": [round(min(xs), 1), round(min(ys), 1), round(max(xs) - min(xs), 1), round(max(ys) - min(ys), 1)],
           "mascot": [am[0], am[1], am[2] - am[0], am[3] - am[1]]}
    (HERE / "wordmark-letters.json").write_text(json.dumps(out) + "\n")
    print(f"{len(paths)} contornos, {len(out['d'])} caracteres; letras {out['letters']}, mascote {out['mascot']}")


if __name__ == "__main__":
    main()
