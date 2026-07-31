#!/usr/bin/env python3
"""src/ と vendor/ を 1 枚の HTML にまとめて成果物を作る。

    python3 tools/build.py

生成物: 棚卸照合ツール.html
Windows PC でこのファイルをダブルクリックすれば、追加インストールなしで動く。
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
VENDOR = ROOT / "vendor"
OUTPUT = ROOT / "棚卸照合ツール.html"

# HTML 内のプレースホルダ → 差し込むファイル
PARTS = {
    "/*__STYLE__*/": SRC / "style.css",
    "/*__XLSX__*/": VENDOR / "xlsx.full.min.js",
    "/*__RECONCILE__*/": SRC / "reconcile.js",
    "/*__APP__*/": SRC / "app.js",
}


def main() -> None:
    html = (SRC / "index.html").read_text(encoding="utf-8")

    for placeholder, path in PARTS.items():
        if placeholder not in html:
            raise SystemExit(f"プレースホルダ {placeholder} が index.html にありません")
        content = path.read_text(encoding="utf-8")
        # インラインスクリプト内の </script> はパーサを壊すため無害化する
        content = content.replace("</script>", "<\\/script>")
        # str.replace は置換文字列内の後方参照を解釈しないのでそのまま使える
        html = html.replace(placeholder, content, 1)

    OUTPUT.write_text(html, encoding="utf-8")
    size_mb = OUTPUT.stat().st_size / 1024 / 1024
    print(f"生成しました: {OUTPUT.relative_to(ROOT)} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
