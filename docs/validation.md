# Version 17 validation record — Loop branding

Version 17 changes the visible app name to Loop, prepares the Loop: Tech Support listing and adds the branding/search copy brief. Internal data, bridge and store identifiers stay stable.

Completed in this environment after the rename:

- Offline web build, JavaScript syntax and bundled asset checks.
- Visible-brand scan confirms Loop in source UI, native display name, configuration and generated web copies. Title, subtitle, promotional text and keyword character counts are recorded in the listing draft.
- Runtime storage validation, corruption recovery, save/erase ordering, and expired-entitlement rejection.
- Eleven controller checks covering first launch, My Tech persistence, language persistence, protected saved-state formats, purchase outcomes, duplicate-request prevention, restore/manage, guide progress and data erasure.
- All 57 free guide graphs and 14 premium introductions remain reachable.
- Native source, project paths, privacy manifest and StoreKit configuration were reviewed structurally in Version 16; the Version 17 change updates the native display name and user-facing messages. The local StoreKit product description also fits the App Store 55-character limit.
- Unsigned release preflight passes. Distribution preflight correctly blocks the unfinished operator/contact/legal/product configuration.

Not executed here: Xcode compilation, native XCTest, iPhone layout/VoiceOver checks, real Sandbox/TestFlight transactions, code signing or App Store upload. Codemagic workflows include the JavaScript checks and native compile/tests.

Catalogue sources were reviewed in the earlier catalogue work; these tests do not independently re-verify manufacturer announcements or physically test each device.
