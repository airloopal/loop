#!/usr/bin/env python3
"""Validate bundled inputs; --distribution also checks public release metadata.

This does not sign an app, contact App Store Connect, or certify App Review
readiness. Run the native build and the device/StoreKit checks documented in
docs/ios-release.md before distributing to customers.
"""

import argparse
import json
from pathlib import Path
import plistlib
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
PLACEHOLDERS = re.compile(r"replace[_ -]?with|example\.(?:com|org|net)|\[.+?\]|todo|tbd", re.I)
ID_PATTERN = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--distribution", action="store_true",
                        help="Fail for missing consumer metadata and check public legal URLs.")
    args = parser.parse_args()
    errors = []
    release_gaps = []
    config_file = ROOT / "app/app-config.json"
    try:
        config = json.loads(config_file.read_text())
        if not isinstance(config, dict):
            raise ValueError("configuration must be an object")
    except (OSError, ValueError) as exc:
        print(f"FAIL: Cannot read app/app-config.json: {exc}", file=sys.stderr)
        return 1

    for key in ("bundleID", "productID"):
        value = config.get(key, "")
        if not isinstance(value, str) or not ID_PATTERN.fullmatch(value) or PLACEHOLDERS.search(value):
            errors.append(f"{key} must be a real reverse-domain identifier in app/app-config.json.")
    if type(config.get("purchasesEnabled")) is not bool:
        errors.append("purchasesEnabled must be true or false, not a string.")
    elif not config["purchasesEnabled"]:
        release_gaps.append("purchasesEnabled is false; configure and test the App Store subscription before enabling purchases.")

    for key in ("operatorName", "supportEmail", "privacyURL", "termsURL"):
        value = config.get(key, "")
        if not isinstance(value, str) or not value.strip() or PLACEHOLDERS.search(value):
            release_gaps.append(f"Set {key} to the actual operator/contact/published page in app/app-config.json.")
            continue
        if key == "supportEmail" and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            release_gaps.append("supportEmail is not a valid support email address.")
        if key.endswith("URL"):
            url = urlsplit(value)
            if url.scheme != "https" or not url.hostname or url.username or url.password:
                release_gaps.append(f"{key} must be a public HTTPS URL without embedded credentials.")
            elif url.hostname in ("localhost", "127.0.0.1", "::1") or "." not in url.hostname:
                release_gaps.append(f"{key} must be a public HTTPS URL.")
            elif args.distribution:
                try:
                    request = Request(value, headers={"User-Agent": "LittleSteps-ReleasePreflight/1.0"})
                    with urlopen(request, timeout=15) as response:
                        final_url = urlsplit(response.geturl())
                        if final_url.scheme != "https" or not response.read(1):
                            release_gaps.append(f"{key} must load a non-empty HTTPS page.")
                except (HTTPError, URLError, TimeoutError, OSError) as exc:
                    release_gaps.append(f"{key} could not be opened: {exc}")

    required_files = (
        "web/index.html", "web/app.css", "web/app.js", "web/config.js",
        "ios/Resources/Web/index.html", "ios/Resources/AppConfig.json",
        "ios/project.yml", "codemagic.yaml",
        "ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png",
        "ios/Resources/PrivacyInfo.xcprivacy", "ios/FullAccess.storekit",
    )
    for name in required_files:
        path = ROOT / name
        if not path.is_file() or path.stat().st_size == 0:
            errors.append(f"Missing {name}; run python3 scripts/build-web.py and include native project files.")

    native_config = ROOT / "ios/Resources/AppConfig.json"
    if native_config.is_file():
        try:
            if json.loads(native_config.read_text()) != config:
                errors.append("Bundled AppConfig.json is stale; rerun python3 scripts/build-web.py.")
        except ValueError:
            errors.append("Bundled AppConfig.json is not valid JSON.")

    privacy = ROOT / "ios/Resources/PrivacyInfo.xcprivacy"
    if privacy.is_file():
        try:
            manifest = plistlib.loads(privacy.read_bytes())
            if not isinstance(manifest, dict) or "NSPrivacyAccessedAPITypes" not in manifest:
                errors.append("PrivacyInfo.xcprivacy is missing its accessed-API declarations.")
        except (ValueError, plistlib.InvalidFileException):
            errors.append("PrivacyInfo.xcprivacy is not a valid property list.")

    storekit = ROOT / "ios/FullAccess.storekit"
    if storekit.is_file():
        try:
            sample = json.loads(storekit.read_text())
            products = [product for group in sample.get("subscriptionGroups", [])
                        for product in group.get("subscriptions", [])]
            product = next((item for item in products if item.get("productID") == config.get("productID")), None)
            if not product or product.get("recurringSubscriptionPeriod") != "P1Y" or str(product.get("displayPrice")) != "49.99":
                errors.append("Local StoreKit test product must match productID and the intended annual US price of 49.99.")
        except (ValueError, TypeError, AttributeError):
            errors.append("ios/FullAccess.storekit is not a valid StoreKit product configuration.")

    project = ROOT / "ios/project.yml"
    if project.is_file() and isinstance(config.get("bundleID"), str):
        text = project.read_text()
        if config["bundleID"] not in text:
            errors.append("bundleID does not match ios/project.yml; update the native target and signing configuration together.")

    workflow = ROOT / "codemagic.yaml"
    if workflow.is_file():
        signing_id = re.search(r"^\s*bundle_identifier:\s*([^\s#]+)", workflow.read_text(), re.M)
        if not signing_id or signing_id.group(1).strip("\"'") != config.get("bundleID"):
            errors.append("bundleID does not match the Codemagic signing bundle_identifier.")

    web = ROOT / "web"
    native_web = ROOT / "ios/Resources/Web"
    if web.is_dir() and native_web.is_dir():
        for source in web.rglob("*"):
            if source.is_file():
                target = native_web / source.relative_to(web)
                if not target.is_file() or source.read_bytes() != target.read_bytes():
                    errors.append(f"Native web resource is missing or stale: {source.relative_to(web)}. Rerun scripts/build-web.py.")

    for relative in ("web/index.html", "web/app.css"):
        path = ROOT / relative
        if path.is_file():
            source = path.read_text()
            if re.search(r"(?:src|href)\s*=\s*['\"]https?://", source, re.I) and relative.endswith(".html"):
                # Ordinary manufacturer links are generated by app.js; launch assets must be local.
                errors.append(f"{relative} contains a remote launch asset/link. Review before shipping the offline bundle.")
            if re.search(r"@import\s+(?:url\()?['\"]?https?://|url\(['\"]?https?://", source, re.I):
                errors.append(f"{relative} contains a remote CSS dependency.")

    if args.distribution:
        errors.extend(release_gaps)
    for error in errors:
        print(f"FAIL: {error}", file=sys.stderr)
    if errors:
        print(f"Preflight blocked: {len(errors)} issue(s).", file=sys.stderr)
        return 1
    print("PASS: Bundled inputs and configuration are structurally valid.")
    if args.distribution:
        print("PASS: Required release metadata is present and legal pages respond over HTTPS.")
        print("App Store product availability, signing, device behaviour and App Review approval are not verified by this script.")
    elif release_gaps:
        print("Unsigned validation only. Distribution remains blocked:")
        for gap in release_gaps:
            print(f"  - {gap}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
