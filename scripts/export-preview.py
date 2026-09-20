#!/usr/bin/env python3
"""Export the consumer app as one offline HTML file, with no hosted runtime.

Usage: python3 scripts/export-preview.py [output.html]
The export is a browser preview. Apple purchases remain available only through
the native app bridge, using the same configuration and locked guide logic.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"


def data_url(path: Path, mime: str) -> str:
    return "data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def export(destination: Path) -> None:
    subprocess.run([sys.executable, str(ROOT / "scripts" / "build-web.py"), "--web-only"], check=True)
    document = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "app.css").read_text(encoding="utf-8")

    def embed_font(match: re.Match[str]) -> str:
        relative = match.group(1)
        path = WEB / relative
        return "url(\"" + data_url(path, "font/woff2") + "\")"

    css = re.sub(r"url\([\"']?(assets/fonts/[^\s\"')]+)[\"']?\)", embed_font, css)
    document = document.replace('<link rel="stylesheet" href="app.css">', "<style>\n" + css + "\n</style>")
    document = document.replace('href="assets/app-icon.svg"', 'href="' + data_url(WEB / "assets" / "app-icon.svg", "image/svg+xml") + '"')
    hashes = []
    for relative in ["config.js", "vendor/lucide.min.js", "app.js"]:
        source = (WEB / relative).read_text(encoding="utf-8")
        if "</script" in source.lower():
            raise ValueError(f"Closing script text needs explicit escaping in {relative}")
        # Put these at the end of <body>: inline scripts do not honor defer.
        document = document.replace(f'<script src="{relative}" defer></script>', "")
        inline = "\n" + source + "\n"
        digest = base64.b64encode(hashlib.sha256(inline.encode("utf-8")).digest()).decode("ascii")
        hashes.append("'sha256-" + digest + "'")
        document = document.replace("</body>", "<script>" + inline + "</script>\n</body>")
    csp = "; ".join([
        "default-src 'none'", "script-src " + " ".join(hashes),
        "style-src 'unsafe-inline'", "img-src data:", "font-src data:",
        "connect-src 'none'", "object-src 'none'", "base-uri 'none'",
        "form-action 'none'", "frame-src 'none'", "media-src 'none'", "worker-src 'none'",
    ])
    document = re.sub(r'<meta http-equiv="Content-Security-Policy" content="[^"]*">',
                      '<meta http-equiv="Content-Security-Policy" content="' + html.escape(csp, quote=True) + '">', document)
    licenses = "\n\n".join(path.name + "\n" + path.read_text(encoding="utf-8") for path in sorted((WEB / "licenses").glob("*.txt")))
    document = document.replace("</html>", "<!--\nBundled font and icon licenses:\n" + licenses.replace("--", "—") + "\n-->\n</html>")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(document, encoding="utf-8")
    print(f"Exported standalone preview: {destination} ({destination.stat().st_size:,} bytes).")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path, default=ROOT / "dist" / "loop-preview.html")
    options = parser.parse_args()
    try:
        export(options.output.resolve())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Export failed: {error}", file=sys.stderr)
        sys.exit(1)
