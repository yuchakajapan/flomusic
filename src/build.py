# -*- coding: utf-8 -*-
"""src/ の素材から public/ の各ページを生成する。
    python src/build.py
CSS/JS は全ページ共通の1ファイルを読み込ませるので、エンジンの修正は1箇所で済む。
"""
import io, os, shutil, sys, re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT  = os.path.join(ROOT, "public")

sys.path.insert(0, HERE)
from pages import PAGES, SITE, COMMON_FOOTER

TOOL = io.open(os.path.join(HERE, "tool.html"), encoding="utf-8").read()

FAVICON = ("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
           "%3Crect width='32' height='32' rx='7' fill='%230f1116'/%3E%3Cg fill='%235b8cff'%3E"
           "%3Crect x='5' y='14' width='3' height='4' rx='1.5'/%3E"
           "%3Crect x='10' y='11' width='3' height='10' rx='1.5'/%3E%3C/g%3E%3Cg fill='%23ff7a59'%3E"
           "%3Crect x='15' y='6' width='3' height='20' rx='1.5'/%3E"
           "%3Crect x='20' y='10' width='3' height='12' rx='1.5'/%3E"
           "%3Crect x='25' y='13' width='3' height='6' rx='1.5'/%3E%3C/g%3E%3C/svg%3E")

VERIFY_FILE = "google1ac38f25232608a2.html"   # Google Search Console 所有権確認（ファイル方式・予備）
VERIFY_META = ('<meta name="google-site-verification" '
               'content="EapIR4ipt7l7WvDK_Dp0mbCz6Tf-pbk0gHt6HwcwfhI">')   # 同（メタタグ方式・本命）

BEACON = ('<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js"\n'
          '        data-cf-beacon=\'{"token": "1f2f47e1a4154b53a8d1f38f8151b5d8"}\'></script>')


def url_for(path):
    return SITE + "/" + (path + "/" if path else "")


def nav_html(current):
    items = []
    for p in PAGES:
        href = "/" + (p["path"] + "/" if p["path"] else "")
        cls = ' class="on"' if p["path"] == current else ""
        items.append(f'<a href="{href}"{cls}>{p["nav"]}</a>')
    return '<nav class="sitenav">' + "".join(items) + "</nav>"


def related_html(current):
    """他ページへの内部リンク。ページ同士を繋いでおくと巡回されやすい。"""
    others = [p for p in PAGES if p["path"] != current]
    cards = []
    for p in others:
        href = "/" + (p["path"] + "/" if p["path"] else "")
        cards.append(
            f'<a class="relcard" href="{href}"><b>{p["nav"]}</b><span>{p["tagline"]}</span></a>'
        )
    return '<div class="related"><h2>ほかのツール</h2><div class="relgrid">' + "".join(cards) + "</div></div>"


def build_page(p):
    path = p["path"]
    canon = url_for(path)
    depth_prefix = "/"          # 全ページ絶対パスで参照する

    if p.get("brand"):
        h1 = f'<h1 class="brand">{p["h1"]}</h1>'
    else:
        h1 = f'<h1 class="pagetitle">{p["h1"]}</h1>'

    steps = "".join(
        f'<div class="step"><b>{i+1}</b><span>{s}</span></div>'
        for i, s in enumerate(p["steps"])
    )

    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{p["title"]}</title>
<meta name="description" content="{p["desc"]}">
{VERIFY_META}
<meta name="theme-color" content="#0f1116">
<link rel="canonical" href="{canon}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="flomusic">
<meta property="og:title" content="{p["title"]}">
<meta property="og:description" content="{p["desc"]}">
<meta property="og:url" content="{canon}">
<meta property="og:locale" content="ja_JP">
<meta property="og:image" content="{SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="flomusic — 「ここから」の音を、手に入れる。">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{SITE}/og.png">
<link rel="icon" href="{FAVICON}">
<link rel="stylesheet" href="{depth_prefix}app.css">
</head>
<body>
<div class="wrap">

  {nav_html(path)}

  {h1}
  <p class="tagline">{p["tagline"]}</p>
  <div class="badges">
    <span class="privacy">🔒 音源はあなたのブラウザの中だけで処理されます。どこにもアップロードされません</span>
    <span class="privacy alt">✓ 商用利用OK・登録不要・完全無料</span>
  </div>
  <p class="sub">{p["lead"]}</p>

  <div class="steps">{steps}</div>

{TOOL}

  <footer>
{p["body"]}
{COMMON_FOOTER}
  </footer>

  {related_html(path)}

</div>

<script>window.FLOMUSIC_PAGE = {{ mode: "{p["mode"]}" }};</script>
<script src="{depth_prefix}lame.min.js"></script>
<script src="{depth_prefix}app.js"></script>

{BEACON}
</body>
</html>
"""
    outdir = os.path.join(OUT, path) if path else OUT
    os.makedirs(outdir, exist_ok=True)
    io.open(os.path.join(outdir, "index.html"), "w", encoding="utf-8", newline="\n").write(html)
    return os.path.relpath(os.path.join(outdir, "index.html"), ROOT), len(html)


def main():
    os.makedirs(OUT, exist_ok=True)
    # 共有アセット
    shutil.copyfile(os.path.join(HERE, "app.css"), os.path.join(OUT, "app.css"))
    shutil.copyfile(os.path.join(HERE, "app.js"),  os.path.join(OUT, "app.js"))

    made = []
    for p in PAGES:
        made.append(build_page(p))

    # sitemap.xml
    urls = "".join(
        f"  <url><loc>{url_for(p['path'])}</loc><changefreq>weekly</changefreq>"
        f"<priority>{'1.0' if not p['path'] else '0.8'}</priority></url>\n"
        for p in PAGES
    )
    io.open(os.path.join(OUT, "sitemap.xml"), "w", encoding="utf-8", newline="\n").write(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + "</urlset>\n"
    )
    # Google Search Console の所有権確認ファイル
    io.open(os.path.join(OUT, VERIFY_FILE), "w", encoding="utf-8", newline="\n").write(
        "google-site-verification: " + VERIFY_FILE
    )
    # robots.txt
    io.open(os.path.join(OUT, "robots.txt"), "w", encoding="utf-8", newline="\n").write(
        "User-agent: *\nAllow: /\n\nSitemap: " + SITE + "/sitemap.xml\n"
    )

    for path, size in made:
        print(f"  {path:34} {size:7,d} bytes")
    print(f"  public/sitemap.xml, public/robots.txt")
    print(f"  shared: app.css, app.js, lame.min.js")


if __name__ == "__main__":
    main()
