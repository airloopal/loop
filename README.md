# Loop Tech Support — iOS preparation

Loop provides guided troubleshooting, a saved My Tech collection and optional Full Access guides. This package moves the prototype into an offline iOS app with a native StoreKit purchase boundary. The intended annual US price is **$49.99**. The app must display the current localized price returned by the App Store before a purchase.

**Status:** source prepared for build and device validation. Purchases are disabled until the real subscription and release details are configured. No signed build or App Store submission is implied by this package.

## Brand and app identity

The consumer brand is **Loop**; the proposed App Store name is **Loop: Tech Support**. The search metadata and marketing copy are in [docs/app-store-listing.md](docs/app-store-listing.md) and [docs/brand-and-discovery.md](docs/brand-and-discovery.md). Store name, trademark, domain and handle availability have not been cleared.

The existing `LittleSteps` Xcode project/schemes, native bridge names, saved-data keys and proposed bundle/subscription identifiers are kept stable. These are implementation identifiers, not the name shown to customers.

## Build the bundled app

From this directory, with Python 3 and Node.js installed:

```sh
python3 scripts/build-web.py
python3 scripts/release-preflight.py
node tests/runtime.cjs
node tests/consumer.cjs
```

On a Mac with Xcode and XcodeGen:

```sh
cd ios
xcodegen generate
xcodebuild -project LittleSteps.xcodeproj -scheme LittleSteps -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
open LittleSteps.xcodeproj
```

Use the `LittleSteps` scheme for normal validation and release builds. `LittleSteps-StoreKit` is the local purchase-testing scheme; its StoreKit file simulates products and transactions and is not an App Store product registration.

For that local StoreKit scheme, first set `purchasesEnabled` to `true` in `app/app-config.json`, rerun `python3 scripts/build-web.py`, then select `LittleSteps-StoreKit` in Xcode. Its native override is limited to Debug and the named scheme. Keep the flag false in unconfigured builds; the JavaScript purchase layer also checks it.

The editable UI source is `app/fragment.html`; `app/consumer-runtime.js` owns storage and the native bridge. Change configuration in `app/app-config.json`, then rebuild. `web/` and `ios/Resources/Web/` are generated copies. A standalone browser preview can be exported with `python3 scripts/export-preview.py loop-preview.html`; it cannot grant paid access or process purchases.

## Same deployment route as One More Floor

The GitHub repository is [airloopal/loop](https://github.com/airloopal/loop), using branch `main`. In Codemagic, import or select that repository, select `main`, and run **ios-validate** first. The repository connection does not configure Codemagic or Apple signing automatically. **ios-testflight** follows the recovered One More Floor XcodeGen → signing → IPA → App Store Connect upload pattern. Both workflows are manual; neither submits to App Store review. Complete the specific settings in [docs/ios-release.md](docs/ios-release.md) before selecting the signed workflow.

## What still needs completing

- Supply the operating entity, support email, and published privacy/terms URLs in `app/app-config.json`.
- Create the Loop app ID, matching provisioning profile and annual App Store subscription; connect the existing Apple/Codemagic account.
- Run a successful Mac build, test purchases and restoration in StoreKit/Sandbox, and check the interface, accessibility and saved data on a real iPhone.
- Review catalogue claims, manufacturer artwork rights, privacy disclosures, and final screenshots before submission.

`python3 scripts/release-preflight.py --distribution` blocks missing release details. It cannot prove that App Store Connect is configured or that a device test passed. See the [listing draft](docs/app-store-listing.md), [privacy draft](docs/privacy-policy-draft.md), and [terms draft](docs/terms-draft.md).
