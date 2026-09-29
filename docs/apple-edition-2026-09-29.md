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

## Outstanding

- GitHub connector branch creation returned HTTP 403. The user authorized the signed-in cloud browser fallback; source and bundled resources were uploaded to main through the GitHub UI. CI has not yet run.
- Run ios-validate and ios-media on the revision; inspect native captures and produce matching store artwork.
- Run signed ios-testflight, select the processed build, update App Store Connect metadata/screenshots, then resubmit through private App Review. No new build has been uploaded or submitted from this session.
- Verify Paid Apps agreement/banking and real Sandbox purchases independently; this catalog revision does not establish payment readiness.

Broader source remains in app/fragment.html for future editions. It is not shipped as a hidden user-accessible mode in this iOS build.
