# Apple-focused iOS revision — 29 September 2026

User approved narrowing iOS coverage while retaining Loop's concept.

## Implemented

- Build-time Apple profile generates app/apple-fragment.html from the preserved cross-platform source. Both bundled web output and the native iOS web resources use this profile for all users.
- Six Apple categories, seven free guides and two advanced guides. Search, My Tech and paid coverage derive from the filtered catalog.
- Tap-through troubleshooting, Start/search, language selection, My Tech, premium progress and the annual $49.99 US reference price remain.
- Unsupported previously saved profiles and guide progress are retained locally but not offered as routes. Explicit data erasure clears them too.
- Introduction and About explain guided troubleshooting and that Loop does not supply parts or physical repairs.
- Listing draft states the narrower scope and current paid coverage.
- Native capture label and CI controller checks updated.

## Validation

Passed: generated web build, structural release preflight, runtime tests, 11 original-edition controller checks and 12 Apple-edition controller checks. Controller checks use a DOM stub and mocked native billing; they do not establish native layout or real StoreKit Sandbox operation.

## Initial outstanding items (superseded by progress below)

- GitHub connector branch creation returned HTTP 403. The user authorized the signed-in cloud browser fallback; source and bundled resources were uploaded to main through the GitHub UI. CI has not yet run.
- Run ios-validate and ios-media on the revision; inspect native captures and produce matching store artwork.
- Run signed ios-testflight, select the processed build, update App Store Connect metadata/screenshots, then resubmit through private App Review. No new build has been uploaded or submitted from this session.
- Verify Paid Apps agreement/banking and real Sandbox purchases independently; this catalog revision does not establish payment readiness.

Broader source remains in app/fragment.html for future editions. It is not shipped as a hidden user-accessible mode in this iOS build.

## Build progress at 17:15 UTC

- Remote source verified against the local tested files: main commit `3970fec49d446943938570290997eeea71680f44`.
- `ios-validate` finished successfully in 3m18s. Six native persistence/navigation tests passed with zero failures. Build: https://codemagic.io/app/6aafdf04d83de4e2e8943b2e/build/6abbf0d5083ff0a9a53a7748
- `ios-media` is running: https://codemagic.io/app/6aafdf04d83de4e2e8943b2e/build/6abbf123083ff0a9a53a775b
- `ios-testflight` index 4 is queued from that exact commit, expected build number 104: https://codemagic.io/app/6aafdf04d83de4e2e8943b2e/build/6abbf20e4060813905177868
- App Store Connect requires sign-in. No metadata changes, new screenshot uploads or new review submission have been made.

## App Store Connect at 17:21 UTC

Signed-in access verified. Updated and saved the English (U.S.) promotional text, description, keywords and review notes. Set release to Manual, consistent with the user's requirement that review not automatically make the app public. Build 103 remains selected pending build 104 processing.

Paid Apps Agreement, bank account, tax forms and compliance entries now show Active. Full Access Annual and its subscription group show Ready for Review. No new submission has been sent.

## Build 104 and capture correction

- Signed workflow completed in 4m20s. App Store upload succeeded, delivery UUID `f264b720-7a90-4547-9825-6ef15fd13b6a`, build 104 / version 1.0.0. Apple processing was visible in TestFlight.
- First capture run completed all seven iPad screens. iPhone navigated to the brand screen but its non-interactive heading caused XCUITest's `isHittable` check to throw an invalid activation-point error.
- Corrected capture visibility to compare the content frame with the web viewport, keeping hit testing for interactive controls. Commit `7abbd3ee57b6b594a71709e97a0794e7264c5033` differs from build 104 source only in the UI-test file.
- Capture rerun: https://codemagic.io/app/6aafdf04d83de4e2e8943b2e/build/6abbf4f7083ff0a9a53a7861
- Existing submission retains all three items: app, annual subscription, subscription group. Resubmission awaits replacement build and verified screenshots.

## Store assets complete; awaiting Apple processing

- Capture rerun completed successfully on both platforms, seven native screens each, exit 0. No production app code changed after the signed build; only screenshot test visibility was corrected.
- Rendered and visually checked three new iPhone and three iPad store images. Uploaded 1284x2778 iPhone 6.5-inch and 2064x2752 iPad 13-inch images to English (U.S.). Media Manager confirms smaller sizes inherit them; the optional iPhone 6.9-inch slot remains empty.
- Full Access Annual and its group remain in the existing review submission. Manual release is saved.
- Build 104 is uploaded but Apple still reports Processing. Build 103 remains selected; Update Review / Resubmit has deliberately not been used with the obsolete build.
- Next: after processing completes, select build 104, save, Update Review, then resubmit the existing three-item submission. Verify Waiting for Review. Do not release publicly.
- Paid Apps, banking and tax/compliance are Active. Native StoreKit tests passed; no claim of a real App Store Sandbox purchase is made.
