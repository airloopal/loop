# Validation record

## 20 September 2026 — Codemagic validation passed

[Codemagic build #2](https://codemagic.io/app/6aafdf04d83de4e2e8943b2e/build/6aafe4947d4532890059b650) completed successfully in **3 minutes 33 seconds**, testing commit `288c016dcb721926430b545d5a118fd74ffd26c5` on a Mac mini M2 with Xcode 26.6 and the iOS 26.5 SDK.

- Offline web build, JavaScript checks and unsigned release preflight passed.
- Native simulator compilation succeeded after correcting the `WKWebView.callAsyncJavaScript` completion-handler overload to use the `in:` content-world argument.
- XCTest reported `TEST SUCCEEDED`: six tests passed with zero failures (four `LocalStateStoreTests` and two `NavigationPolicyTests`).
- The build produced an unsigned simulator `.app`, not a physical-iPhone IPA.

Still untested: physical-device layout and accessibility, real Sandbox/TestFlight purchases and restoration, distribution signing, and App Store upload. The existing certificate/integration verification does not replace those tests. Release configuration remains incomplete as described in [ios-release.md](ios-release.md).

## Version 17 — historical local validation after Loop branding

Version 17 changes the visible app name to Loop, prepares the Loop: Tech Support listing and adds the branding/search copy brief. Internal data, bridge and store identifiers stay stable.

Completed locally after the rename, before the Codemagic run recorded above:

- Offline web build, JavaScript syntax and bundled asset checks.
- Visible-brand scan confirms Loop in source UI, native display name, configuration and generated web copies. Title, subtitle, promotional text and keyword character counts are recorded in the listing draft.
- Runtime storage validation, corruption recovery, save/erase ordering, and expired-entitlement rejection.
- Eleven controller checks covering first launch, My Tech persistence, language persistence, protected saved-state formats, purchase outcomes, duplicate-request prevention, restore/manage, guide progress and data erasure.
- All 57 free guide graphs and 14 premium introductions remain reachable.
- Native source, project paths, privacy manifest and StoreKit configuration were reviewed structurally in Version 16; the Version 17 change updates the native display name and user-facing messages. The local StoreKit product description also fits the App Store 55-character limit.
- Unsigned release preflight passes. Distribution preflight correctly blocks the unfinished operator/contact/legal/product configuration.

At this earlier local-validation stage, Xcode compilation and native XCTest had not yet run; both subsequently passed in the Codemagic run above. iPhone layout/VoiceOver checks, real Sandbox/TestFlight transactions, code signing and App Store upload remained pending.

Catalogue sources were reviewed in the earlier catalogue work; these tests do not independently re-verify manufacturer announcements or physically test each device.
