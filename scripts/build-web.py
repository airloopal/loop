#!/usr/bin/env python3
"""Build the offline web UI and copy it into the iOS resource bundle.

The committed app/assets directory contains all dependencies. This script never
downloads packages or contacts a service. Python 3 is the only required tool;
Node, when available, additionally checks every generated JavaScript file.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
WEB = ROOT / "web"


def required(path: Path) -> str:
    if not path.is_file():
        raise ValueError(f"Required input is missing: {path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8")


def lower_light_dark(css: str) -> str:
    """Compile light-dark() into inherited variables for iOS 17.0 WebKit.

    Parse balanced functions instead of splitting on commas: either color may
    itself contain color-mix(), rgb(), or another function with comma arguments.
    This avoids duplicating the large embedded illustration atlas declarations.
    """
    appearances: dict[tuple[str, str], str] = {}

    def transform(source: str) -> str:
        pieces = []
        cursor = 0
        while True:
            match = re.search(r"\blight-dark\s*\(", source[cursor:], re.I)
            if match is None:
                pieces.append(source[cursor:])
                break
            start = cursor + match.start()
            arguments_start = cursor + match.end()
            pieces.append(source[cursor:start])
            depth = 1
            quote_char = None
            escaped = False
            separator = None
            end = None
            for position in range(arguments_start, len(source)):
                character = source[position]
                if escaped:
                    escaped = False
                    continue
                if character == "\\":
                    escaped = True
                    continue
                if quote_char:
                    if character == quote_char:
                        quote_char = None
                    continue
                if character in ("'", '"'):
                    quote_char = character
                elif character == "(":
                    depth += 1
                elif character == ")":
                    depth -= 1
                    if depth == 0:
                        end = position
                        break
                elif character == "," and depth == 1:
                    if separator is not None:
                        raise ValueError("light-dark() must have exactly two colors")
                    separator = position
            if end is None or separator is None:
                raise ValueError("Invalid light-dark() expression in the stylesheet")
            light = transform(source[arguments_start:separator].strip())
            dark = transform(source[separator + 1:end].strip())
            if not light or not dark:
                raise ValueError("Empty light-dark() color in the stylesheet")
            pair = (light, dark)
            variable = appearances.setdefault(pair, f"--ls-appearance-{len(appearances)}")
            pieces.append(f"var({variable})")
            cursor = end + 1
        return "".join(pieces)

    compiled = transform(css)
    if not appearances:
        return compiled
    light_values = ";".join(f"{variable}:{pair[0]}" for pair, variable in appearances.items())
    dark_values = ";".join(f"{variable}:{pair[1]}" for pair, variable in appearances.items())
    return ("/* Compiled light/dark colors support iOS 17.0 and later. */\n"
            + f":root{{{light_values}}}\n"
            + f"@media(prefers-color-scheme:dark){{:root{{{dark_values}}}}}\n"
            + compiled)


def native_css(root_id: str) -> str:
    """Adapt the existing screen to the native safe-area container.

    SwiftUI handles physical safe areas. Do not add env(safe-area-inset-*) here,
    which would create duplicate top/bottom padding in WKWebView.
    """
    return f"""
/* Native shell layout. Content remains zoomable and scrollable. */
:root {{ color-scheme:light dark; -webkit-text-size-adjust:100%; }}
html,body {{ margin:0; width:100%; min-height:100%; background:light-dark(#fff,#151619); }}
body {{ font-family:Poppins,Arial,system-ui,sans-serif; }}
button,input,select,textarea {{ font:inherit; }}
button,a,input,select,textarea {{ -webkit-tap-highlight-color:transparent; }}
button,a {{ touch-action:manipulation; }}
.cursor-interaction,button:not(:disabled),a[href] {{ cursor:pointer; }}
[hidden] {{ display:none!important; }}
#{root_id} {{ margin:0; padding:0; width:100%; min-height:100svh; background:var(--th-bg); }}
#{root_id} .th-phone {{ width:100%; max-width:680px; min-height:100svh; margin:0 auto; padding:20px 22px 14px; border:0; border-radius:0; box-shadow:none; }}
#{root_id} .ls-bottom-nav {{ bottom:10px; }}
#{root_id} .th-top {{ flex-wrap:wrap; row-gap:6px; }}
#{root_id} .th-question,#{root_id} .th-detail,#{root_id} .ls-plan-panel {{ min-width:0; }}
#{root_id} .ls-plan-price {{ overflow-wrap:anywhere; }}
#{root_id} svg {{ flex-shrink:0; }}
@media(max-width:360px) {{
  #{root_id} .th-phone {{ padding:16px 16px 12px; border-radius:0; }}
}}
@media(hover:none) {{
  #{root_id} .th-choice:hover {{ transform:none; }}
}}
@media(prefers-reduced-motion:reduce) {{
  html {{ scroll-behavior:auto; }}
}}
"""


def build(web_only: bool = False) -> None:
    fragment = required(APP / "fragment.html")
    config = json.loads(required(APP / "app-config.json"))
    if not isinstance(config, dict):
        raise ValueError("app/app-config.json must contain a JSON object")
    fonts_css = required(APP / "assets" / "fonts.css")
    vendor_manifest = json.loads(required(APP / "assets" / "vendor-manifest.json"))
    for asset in vendor_manifest:
        path = APP / "assets" / asset["path"]
        if not path.is_file():
            raise ValueError(f"Bundled dependency missing: {asset['path']}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != asset["sha256"]:
            raise ValueError(f"Bundled dependency checksum changed: {asset['path']}")

    styles = re.findall(r"<style\b[^>]*>(.*?)</style\s*>", fragment, re.S | re.I)
    scripts = re.findall(r"<script\b([^>]*)>(.*?)</script\s*>", fragment, re.S | re.I)
    if not styles or not scripts:
        raise ValueError("Fragment must contain its stylesheet and application script")
    if any(re.search(r"\bsrc\s*=", attributes, re.I) for attributes, _ in scripts):
        raise ValueError("The source fragment contains an external script; vendor it first")
    markup = re.sub(r"<(style|script)\b[^>]*>.*?</\1\s*>", "", fragment, flags=re.S | re.I)
    # The prototype's Google Fonts link is replaced by bundled @font-face rules.
    markup = re.sub(r'<link\b[^>]*href=["\']https://fonts\.googleapis\.com/[^"\']*["\'][^>]*>', "", markup, flags=re.I)
    markup = markup.replace('class="viz-dotted-background"', 'class="ls-native-app"').strip()
    if re.search(r"<link\b", markup, re.I):
        raise ValueError("An unbundled link remains in the fragment")
    if re.search(r'<(?:img|source|video|audio|iframe)\b[^>]*\bsrc=["\']https?://', markup, re.I):
        raise ValueError("A remote media resource remains in the initial markup")
    if re.search(r"\son\w+\s*=", markup, re.I):
        raise ValueError("Inline event handlers cannot run under the app CSP")
    root_match = re.search(r'<div\b[^>]*\bid=["\']([a-zA-Z][\w-]*)["\']', markup)
    if not root_match:
        raise ValueError("Cannot find the app root div")
    root_id = root_match.group(1)
    css = lower_light_dark(fonts_css + "\n" + "\n".join(styles) + native_css(root_id))
    if re.search(r"@import\b|url\([\s\"']*https?://", css, re.I):
        raise ValueError("A remote CSS dependency remains")
    runtime_path = APP / "consumer-runtime.js"
    runtime = runtime_path.read_text(encoding="utf-8") if runtime_path.exists() else ""
    javascript = "/* Built from app/consumer-runtime.js and app/fragment.html. */\n" + runtime + "\n;\n" + "\n;\n".join(source for _, source in scripts) + "\n"
    config_js = "/* Local release configuration. Never fetched at launch. */\nwindow.LITTLE_STEPS_CONFIG = Object.freeze(" + json.dumps(config, ensure_ascii=True, separators=(",", ":")) + ");\n"

    WEB.mkdir(parents=True, exist_ok=True)
    for directory in ("assets", "vendor", "licenses"):
        target = WEB / directory
        if target.exists():
            shutil.rmtree(target)
    (WEB / "assets").mkdir()
    shutil.copytree(APP / "assets" / "fonts", WEB / "assets" / "fonts")
    shutil.copytree(APP / "assets" / "vendor", WEB / "vendor")
    shutil.copytree(APP / "assets" / "licenses", WEB / "licenses")
    icon = APP / "assets" / "app-icon-source.svg"
    if icon.exists():
        shutil.copy2(icon, WEB / "assets" / "app-icon.svg")
    (WEB / "app.css").write_text(css, encoding="utf-8")
    (WEB / "app.js").write_text(javascript, encoding="utf-8")
    (WEB / "config.js").write_text(config_js, encoding="utf-8")
    # Style attributes are used to position the embedded product illustrations.
    # Script execution stays local-only: no unsafe-inline, unsafe-eval or network.
    csp = "; ".join([
        "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:", "font-src 'self'", "connect-src 'none'",
        "object-src 'none'", "base-uri 'none'", "form-action 'none'",
        "frame-src 'none'", "media-src 'none'", "worker-src 'none'",
    ])
    index = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="format-detection" content="telephone=no">
  <meta http-equiv="Content-Security-Policy" content="{html.escape(csp, quote=True)}">
  <title>Loop Tech Support | Simple Device Troubleshooting</title>
  <meta name="description" content="Get help with everyday tech. Loop guides you through simple checks for phones, TVs, computers, printers and apps. Save your devices in My Tech.">
  <meta name="application-name" content="Loop">
  <meta name="apple-mobile-web-app-title" content="Loop">
  <link rel="icon" href="assets/app-icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="app.css">
  <script src="config.js" defer></script>
  <script src="vendor/lucide.min.js" defer></script>
  <script src="app.js" defer></script>
</head>
<body>
{markup}
<noscript>Loop needs JavaScript enabled to show its troubleshooting guides.</noscript>
</body>
</html>
"""
    (WEB / "index.html").write_text(index, encoding="utf-8")
    if shutil.which("node"):
        for path in (WEB / "config.js", WEB / "vendor" / "lucide.min.js", WEB / "app.js"):
            subprocess.run(["node", "--check", str(path)], check=True)

    hashes = {
        str(path.relative_to(WEB)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(WEB.rglob("*"))
        if path.is_file() and path.name != "build-manifest.json"
    }
    manifest = {"formatVersion": 1, "offlineBundle": True, "files": hashes}
    (WEB / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if not web_only:
        resources = ROOT / "ios" / "Resources"
        resources.mkdir(parents=True, exist_ok=True)
        destination = resources / "Web"
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(WEB, destination)
        shutil.copy2(APP / "app-config.json", resources / "AppConfig.json")
    byte_count = sum(path.stat().st_size for path in WEB.rglob("*") if path.is_file())
    print(f"Built {len(hashes)} local web resources ({byte_count:,} bytes).")
    print("Launch dependencies: local files and embedded data only.")
    if not web_only:
        print("Copied web UI and configuration to ios/Resources.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-only", action="store_true", help="Skip copying into ios/Resources")
    options = parser.parse_args()
    try:
        build(options.web_only)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Build failed: {error}", file=sys.stderr)
        sys.exit(1)
