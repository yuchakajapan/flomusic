# -*- coding: utf-8 -*-
"""OG画像（SNS共有時のカード）を生成する。
    python src/make_og.py
サイト本体と同じ配色・同じモチーフ（波形＋検出マーカー）で揃える。
"""
import io, os, math, random
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT  = os.path.join(os.path.dirname(HERE), "public", "og.png")

W, H = 1200, 630
BG      = (15, 17, 22)
PANEL   = (23, 26, 34)
LINE    = (42, 47, 60)
FG      = (232, 234, 240)
MUTED   = (154, 163, 181)
ACCENT  = (91, 140, 255)
ACCENT2 = (255, 122, 89)
OK      = (61, 220, 151)

F_LATIN = "C:/Windows/Fonts/seguibl.ttf"      # Segoe UI Black（欧文ワードマーク用）
F_JP_B  = "C:/Windows/Fonts/YuGothB.ttc"      # 游ゴシック Bold
F_JP_M  = "C:/Windows/Fonts/YuGothM.ttc"      # 游ゴシック Medium


def font(path, size, index=0):
    return ImageFont.truetype(path, size, index=index)


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # ── 下部を波形バンドとして独立させる（文字と重ねない）────────────
    BAND_TOP = 392
    d.rectangle([0, BAND_TOP, W, H], fill=(19, 22, 29))
    d.rectangle([0, BAND_TOP, W, BAND_TOP + 1], fill=LINE)

    random.seed(11)
    mid = BAND_TOP + (H - BAND_TOP) * 0.52
    bar_w, gap = 5, 6
    n = (W + gap) // (bar_w + gap)
    max_h = (H - BAND_TOP) * 0.40

    # 静か → じわじわ上がる → ドロップ（ここを検出）→ 落ちる → 戻る
    def envelope(u):
        if u < 0.20:  return 0.18
        if u < 0.46:  return 0.18 + 0.72 * ((u - 0.20) / 0.26)
        if u < 0.76:  return 1.00
        if u < 0.88:  return 0.26
        return 0.85

    hl_start, hl_end = 0.46, 0.76          # 盛り上がり区間＝検出結果

    x0, x1 = hl_start * W, hl_end * W
    d.rectangle([x0, BAND_TOP + 1, x1, H], fill=(26, 35, 56))

    for i in range(n):
        u = i / (n - 1)
        amp = envelope(u) * (0.60 + 0.40 * random.random())
        h = amp * max_h
        x = i * (bar_w + gap)
        inside = hl_start <= u <= hl_end
        col = ACCENT if inside else (56, 72, 116)
        d.rounded_rectangle([x, mid - h, x + bar_w, mid + h], radius=2, fill=col)

    # 切り出し位置のマーカー
    for mx in (x0, x1):
        d.rectangle([mx - 2, BAND_TOP + 1, mx + 2, H], fill=ACCENT2)

    # ── ワードマーク ────────────────────────────────────────────
    f_brand = font(F_LATIN, 100)
    bx, by = 70, 74
    d.text((bx, by), "flo", font=f_brand, fill=ACCENT)
    d.text((bx + d.textlength("flo", font=f_brand), by), "music", font=f_brand, fill=FG)

    # 右上にドメイン
    f_url = font(F_JP_M, 21, index=0)
    url = "flomusic.forworld.workers.dev"
    d.text((W - d.textlength(url, font=f_url) - 70, 108), url, font=f_url, fill=(108, 118, 138))

    # ── コピー ──────────────────────────────────────────────────
    f_lead = font(F_JP_B, 42, index=0)
    d.text((74, 206), "「ここから」の音を、手に入れる。", font=f_lead, fill=FG)

    # 1行にまとめてバッジとの余白を確保する
    f_sub = font(F_JP_M, 26, index=0)
    d.text((76, 272), "曲の盛り上がりを自動で見つけて切り出す。ループBGMも作れます。",
           font=f_sub, fill=MUTED)

    # ── バッジ（波形バンドの上、余白の中に置く）──────────────────
    f_badge = font(F_JP_B, 22, index=0)
    badges = [("完全無料", OK), ("登録不要", OK), ("商用利用OK", OK), ("アップロード不要", ACCENT)]
    x, y = 70, 330
    for text, col in badges:
        tw = d.textlength(text, font=f_badge)
        pad = 18
        rounded(d, [x, y - 7, x + tw + pad * 2, y + 36], 22,
                fill=PANEL, outline=(col[0] // 3, col[1] // 3, col[2] // 3), width=2)
        d.text((x + pad, y), text, font=f_badge, fill=col)
        x += tw + pad * 2 + 12

    img.save(OUT, "PNG", optimize=True)
    print(f"  {os.path.relpath(OUT)}  {W}x{H}  {os.path.getsize(OUT)/1024:.1f} KB")


if __name__ == "__main__":
    main()
