#!/bin/bash
# Run after `cd ios && xcodegen generate` on a Mac with an iOS Simulator.
# The isolated test bundle contains the local StoreKit configuration. Neither
# the release scheme nor the production app receives a StoreKit test override.
set -euo pipefail

LOOP_PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$LOOP_PROJECT_ROOT"

if [ -z "${LOOP_STOREKIT_SIMULATOR_ID:-}" ]; then
  LOOP_STOREKIT_SIMULATOR_ID="$(xcrun simctl list devices available --json | python3 -c '
import json, re, sys
devices = json.load(sys.stdin).get("devices", {})
candidates = []
for runtime, entries in devices.items():
    match = re.search(r"\.iOS-(\d+)-(\d+)", runtime)
    if not match:
        continue
    version = tuple(map(int, match.groups()))
    for device in entries:
        if device.get("isAvailable") and device.get("name", "").startswith("iPhone"):
            # Apple reported local StoreKit configuration failures in these
            # runtimes. Prefer another installed version, but let an actual
            # test failure report unsupported environments rather than skip.
            unaffected = version not in {(26, 4), (26, 5)}
            candidates.append((unaffected, version, device["name"], runtime, device["udid"]))
if not candidates:
    raise SystemExit("No available iPhone simulator for StoreKit validation.")
selected = max(candidates)
print("StoreKit validation: " + selected[2] + " / " + selected[3], file=sys.stderr)
if not selected[0]:
    print("Warning: this runtime has a reported StoreKitTest configuration issue; prefer iOS 26.6+ or an earlier unaffected runtime.", file=sys.stderr)
print(selected[4])
')"
fi

xcodebuild \
  -project ios/LittleSteps.xcodeproj \
  -scheme Loop-StoreKitValidation \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$LOOP_STOREKIT_SIMULATOR_ID" \
  -derivedDataPath build/storekit-validation \
  -resultBundlePath build/LoopStoreKitTests.xcresult \
  -parallel-testing-enabled NO \
  -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 60 \
  -maximum-test-execution-time-allowance 90 \
  CODE_SIGNING_ALLOWED=NO test
