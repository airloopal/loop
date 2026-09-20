#!/usr/bin/env python3
"""Capture real simulator UI through XCUITest; export originals and provenance.

Requires macOS, Xcode 16+ and an already generated ios/LittleSteps.xcodeproj.
Uses only a separate simulator UI-test scheme. No signing or purchase entitlement.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build/media"
BUNDLE_ID = "com.littlesteps.techhelp"
EXPECTED = ["01-welcome", "02-home", "03-phone-brands", "04-apple-models",
            "05-free-wifi-check", "06-my-tech", "07-advanced-guide-preview"]
SIZES = {"iphone": {(1320, 2868), (1290, 2796)},
         "ipad": {(2064, 2752), (2048, 2732)}}


def run(*args: str, check: bool = True, log: Path | None = None) -> subprocess.CompletedProcess:
    print("+", " ".join(map(str, args)), flush=True)
    if log:
        with log.open("w") as stream:
            result = subprocess.run(args, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, text=True)
        if result.returncode:
            print(log.read_text()[-24000:])
    else:
        result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
        if result.stdout:
            print(result.stdout[-12000:])
        if result.stderr:
            print(result.stderr[-12000:])
    if check and result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(args)}")
    return result


def select_devices() -> list[dict]:
    devices = json.loads(run("xcrun", "simctl", "list", "devices", "available", "--json").stdout)["devices"]
    choices = []
    for family, names in (
        ("iphone", ["iPhone 17 Pro Max", "iPhone 16 Pro Max", "iPhone 16 Plus", "iPhone 15 Pro Max"]),
        ("ipad", ["iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)", "iPad Pro (12.9-inch) (6th generation)"]),
    ):
        candidates = []
        for runtime, items in devices.items():
            if ".iOS-" not in runtime:
                continue
            version = tuple(int(x) for x in re.findall(r"\d+", runtime.rsplit("iOS-", 1)[1]))
            for device in items:
                if device.get("isAvailable") and device["name"] in names:
                    candidates.append((names.index(device["name"]), tuple(-x for x in version), runtime, device))
        if not candidates:
            raise RuntimeError(f"No supported {family} screenshot simulator. Expected one of: {names}")
        _, _, runtime, device = sorted(candidates, key=lambda row: row[:2])[0]
        choices.append({"family": family, "runtime": runtime, "name": device["name"], "udid": device["udid"]})
    return choices


def attachment_records(value):
    if isinstance(value, dict):
        if "exportedFileName" in value:
            yield value
        for child in value.values():
            yield from attachment_records(child)
    elif isinstance(value, list):
        for child in value:
            yield from attachment_records(child)


def export_screenshots(result: Path, destination: Path, family: str) -> list[dict]:
    export = destination / "attachments"
    export.mkdir()
    run("xcrun", "xcresulttool", "export", "attachments", "--path", str(result), "--output-path", str(export))
    raw_manifest = export / "manifest.json"
    if not raw_manifest.is_file():
        raise RuntimeError("xcresulttool did not write its attachment manifest; original xcresult is retained.")
    captures = []
    for record in attachment_records(json.loads(raw_manifest.read_text())):
        name = record.get("suggestedHumanReadableName", "") or record.get("name", "")
        match = next((capture for capture in EXPECTED if f"loop-{capture}" in name), None)
        if not match:
            continue
        source = export / record["exportedFileName"]
        header = source.read_bytes()[:24]
        if header[:8] != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError(f"Expected original PNG screenshot: {source.name}")
        width, height = struct.unpack(">II", header[16:24])
        if (width, height) not in SIZES[family]:
            raise RuntimeError(f"Unexpected {family} native dimensions {width}x{height}; do not silently resize screenshots.")
        filename = f"loop-{family}-{match}.png"
        shutil.copyfile(source, destination / filename)
        captures.append({"file": filename, "width": width, "height": height,
                         "screen": match, "sourceAttachment": record["exportedFileName"]})
    return sorted(captures, key=lambda row: row["screen"])


def main() -> None:
    if sys.platform != "darwin":
        raise SystemExit("Run this workflow on a macOS Xcode host, such as Codemagic mac_mini_m2.")
    if OUT.exists():
        raise SystemExit("build/media already exists. Move the previous capture before starting a new run.")
    OUT.mkdir(parents=True)
    devices = select_devices()
    xcode = run("xcodebuild", "-version").stdout.strip()
    commit = run("git", "rev-parse", "HEAD").stdout.strip()
    base = ["xcodebuild", "-project", "ios/LittleSteps.xcodeproj", "-scheme", "Loop-MediaCapture",
            "-configuration", "Debug", "-derivedDataPath", "build/media-derived"]
    run(*base, "-destination", "generic/platform=iOS Simulator", "CODE_SIGNING_ALLOWED=NO",
        "build-for-testing", log=OUT / "build-for-testing.log")
    configuration = json.loads((ROOT / "app/app-config.json").read_text())
    manifest = {"sourceCommit": commit, "xcode": xcode, "locale": "en_US", "appearance": "light",
                "statusBarTime": "9:41", "purchasesEnabledForCapture": configuration.get("purchasesEnabled", False),
                "captureMethod": "Unmodified app UI, XCUITest screen attachments", "status": "incomplete", "devices": []}
    for device in devices:
        family, udid = device["family"], device["udid"]
        target = OUT / family
        target.mkdir()
        entry = {**device, "screenshots": [], "status": "incomplete", "errors": [], "missingScreens": EXPECTED[:], "testExitCode": None}
        manifest["devices"].append(entry)
        result = target / "LoopMedia.xcresult"
        try:
            run("xcrun", "simctl", "boot", udid, check=False)
            run("xcrun", "simctl", "bootstatus", udid, "-b")
            run("xcrun", "simctl", "ui", udid, "appearance", "light")
            run("xcrun", "simctl", "status_bar", udid, "override", "--time", "9:41",
                "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
                "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100")
            # Erases only Loop's state on a disposable CI simulator, so onboarding is real.
            run("xcrun", "simctl", "uninstall", udid, BUNDLE_ID, check=False)
            test = run(*base, "-destination", f"platform=iOS Simulator,id={udid}",
                       "-resultBundlePath", str(result), "-parallel-testing-enabled", "NO",
                       "-maximum-concurrent-test-simulator-destinations", "1", "CODE_SIGNING_ALLOWED=NO",
                       "test-without-building", log=target / "capture.log", check=False)
            entry["testExitCode"] = test.returncode
            if test.returncode:
                entry["errors"].append(f"UI capture test exited with {test.returncode}; inspect capture.log and xcresult.")
        except Exception as error:
            entry["errors"].append(str(error))
        finally:
            # A failed late selector must not discard already captured native frames
            # or prevent us from trying the second device family.
            if result.exists():
                try:
                    entry["screenshots"] = export_screenshots(result, target, family)
                except Exception as error:
                    entry["errors"].append(f"Attachment export: {error}")
            entry["missingScreens"] = sorted(set(EXPECTED) - {capture["screen"] for capture in entry["screenshots"]})
            if not entry["missingScreens"] and not entry["errors"] and entry["testExitCode"] == 0:
                entry["status"] = "complete"
            run("xcrun", "simctl", "status_bar", udid, "clear", check=False)
            run("xcrun", "simctl", "shutdown", udid, check=False)
            (OUT / "screenshots-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    if all(device["status"] == "complete" for device in manifest["devices"]):
        manifest["status"] = "complete"
    (OUT / "screenshots-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # Keep the downloadable media pack small; full xcresults and original exports
    # remain separate Codemagic artifacts for debugging and provenance.
    archive = ROOT / "build/Loop-App-Store-Captures.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
        package.write(OUT / "screenshots-manifest.json", "screenshots-manifest.json")
        for device in manifest["devices"]:
            for screenshot in device["screenshots"]:
                relative = Path(device["family"]) / screenshot["file"]
                package.write(OUT / relative, str(relative))
    print("Native screenshots and provenance: build/Loop-App-Store-Captures.zip")
    if manifest["status"] != "complete":
        raise SystemExit("Capture incomplete. Both devices were attempted and partial media was packaged; inspect screenshots-manifest.json.")


if __name__ == "__main__":
    main()
