# iOS release setup

Signed version **1.0.0 (103)**, including the approved Loop icon and final-domain legal URLs at looptech.app, has successfully uploaded to App Store Connect. All three native local StoreKit tests passed with zero failures. Apple completed processing and marked build 103 Ready to Submit. Build 103 has replaced build 102 as the selected, saved build on iOS version 1.0; it has not been submitted for App Review. Physical-device/TestFlight Sandbox validation, business verification, remaining review requirements and Apple approval remain pending. Historical validation and upload records appear below and in [the validation record](validation.md).

## Repository and Codemagic

Use [airloopal/loop](https://github.com/airloopal/loop), with this directory at its root and branch `main`. The reference project is `airloopal/one-more-floor`; its build conventions were recovered from its local source. Do not put Loop into that app's bundle ID or overwrite its App Store record.

The repository is connected to the [Loop Codemagic app](https://codemagic.io/app/6aafdf04d83de4e2e8943b2e/settings). Select branch **main**, use the root `codemagic.yaml`, and select **ios-validate**. On 20 September 2026, [validation build #2](https://codemagic.io/app/6aafdf04d83de4e2e8943b2e/build/6aafe4947d4532890059b650) passed for commit `288c016dcb721926430b545d5a118fd74ffd26c5`: offline/web checks, preflight, simulator compilation and all six native persistence/navigation tests succeeded. The produced `.app` runs in Simulator; it cannot be installed on a physical iPhone as an IPA.

For **ios-testflight**, confirm the configured values and complete the remaining setup:

| Location | Required value |
|---|---|
| `app/app-config.json` → `bundleID` | Registered explicit App ID `com.littlesteps.techhelp`, with the Apple Developer description `Loop Tech Support`. |
| `ios/project.yml` and `codemagic.yaml` | The same bundle identifier. |
| Codemagic `integrations.app_store_connect` | Configured as `One More Floor`; the existing integration was verified by successfully fetching Apple provisioning profiles through Codemagic. |
| Codemagic `APP_STORE_APPLE_ID` | Configured as `6814186180`, the verified Loop App Store Connect app ID. |
| Codemagic signing identities | Verified certificate `one_more_floor_distribution` and matching imported profile `loop_app_store` (`Loop App Store`). |
| `LS_BUILD_OFFSET` | A value making the next CI build number greater than all previous Loop uploads. |

The [Loop: Tech Support App Store Connect record](https://appstoreconnect.apple.com/apps/6814186180/distribution) is created with primary language **English (U.S.)**, SKU `loop-tech-support-ios`, and bundle ID `com.littlesteps.techhelp`. Access is limited to the owner, Dan Vernon, with the existing Admin role.

Codemagic confirms the existing distribution certificate `one_more_floor_distribution` for team **Daniel Vernon**, expiring **19 September 2027**. Apple generated the **Loop App Store** provisioning profile for `A35TN6NA76.com.littlesteps.techhelp`, also expiring **19 September 2027**. It is imported into Codemagic as `loop_app_store`, where the matching uploaded certificate is confirmed. Signed builds 102 and 103 passed archive and upload, as recorded below. The operator is OPAL International Ltd. The user supplied the final domain `looptech.app` and review telephone `+442034323492`; the review contact remains Daniel Vernon, request@flyopal.com.

The signed workflow performs `--distribution` checks, increments the build version, applies profiles, archives, and uploads to App Store Connect. It does not automatically submit to beta review or App Store review. After Apple processes the build, assign internal TestFlight testers in App Store Connect. Do not select that workflow until the first unsigned build and configuration checks have passed.

## Full Access subscription

The **Full Access** subscription group (ID `22399472`) and its [annual auto-renewable subscription](https://appstoreconnect.apple.com/apps/6814186180/distribution/subscriptions/6814187206) have been created in App Store Connect. The product is **Ready for Review**, added to the draft submission. It has not been sent to Apple for review.

| Field | Value |
|---|---|
| Reference name | Full Access Annual |
| Customer-facing plan name | Full Access |
| Apple subscription ID | `6814187206` |
| Product ID | `com.littlesteps.techhelp.fullaccess.annual` |
| Duration | 1 year |
| Saved US starting price | USD $49.99 per year, verified in the subscription pricing table |
| Annual payment availability | All 175 currently selectable countries or regions |
| English (U.S.) product localization | Full Access — Advanced guides for supported devices and apps. |
| English (U.S.) group localization | Full Access, using the app name Loop: Tech Support |
| Included content | The available advanced troubleshooting guides for supported devices/apps; basic checks and My Tech stay free. |

The saved plan charges annually upfront; monthly payments with a 12-month commitment have not been configured. The subscription review screenshot and notes are saved. Complete the remaining app/review information and applicable paid-app agreements, tax and banking details. The saved price, availability and localization do not establish Apple approval or customer availability. `purchasesEnabled` is now true for the configured TestFlight candidate. Product price must come from StoreKit, and unavailable product data must leave the purchase button unavailable. The local `.storekit` file is only for simulated transactions.

For local Xcode tests using the `LittleSteps-StoreKit` scheme, set `app/app-config.json` → `purchasesEnabled: true` and rebuild the web bundle first. Both the web and native layers must allow the test transaction. Use that scheme only for local simulation; the `LittleSteps` release scheme has no StoreKit configuration file attached.

Before customer release, test a successful purchase, cancellation, pending approval, restoration after reinstall, expiration/revocation, and offline relaunch with existing access. Confirm premium content never unlocks from a web preview flag. The live purchase screen must state the subscription name, annual duration, current localized price, auto-renewal and cancellation terms, with working Privacy, Terms, Restore and Manage Subscription actions.

## Consumer release checks

1. **Actual build:** `ios-validate` passes on Mac; the signed archive passes upload validation. Record the tested commit and build number.
2. **Device experience:** on a small and a current iPhone, check category/brand/model selection, search, My Tech after force-quit, guide progress, Back, keyboard, portrait/landscape safe areas, VoiceOver, large text and Reduce Motion. Verify Erase local data and native summary sharing.
3. **Content:** review the published coverage and manufacturer sources. The catalogue is manually maintained; a listed model is not a claim of an exact-model guide. Coming-soon models must not offer paid troubleshooting.
4. **Store details:** publish the completed legal pages; set a working support contact/URL; review privacy answers, content rights and age-rating answers against the final binary; capture real screenshots. Do not claim all guide text is translated.
5. **Purchases:** complete the Sandbox/TestFlight scenarios above, with the correct product, annual period and verified localized price.

The source uses an app interface with bundled content and native purchase/share integration, but Apple still decides whether it provides sufficient app utility under its review rules.

## Official references

- [Codemagic native iOS workflow](https://docs.codemagic.io/yaml-quick-start/building-a-native-ios-app/) — project generation, signing and archive setup.
- [Codemagic App Store Connect publishing](https://docs.codemagic.io/yaml-publishing/app-store-connect/) — upload versus beta/App Store review settings.
- [Apple subscription guidance](https://developer.apple.com/app-store/subscriptions/) — product setup, pricing and subscription presentation.
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — digital purchases, clear subscription scope, in-app privacy links and meaningful app functionality.
- [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/) — complete disclosures from the final app's actual data handling.

## Historical signed candidate 102 — 20 September 2026

Build 102 uses the approved 1024 × 1024 opaque Loop icon, OPAL International Ltd as operator, request@flyopal.com for support, and the published privacy/terms pages at https://loop-tech-support.flyopal.chatgpt.site. Purchases are enabled for the configured annual product. Distribution preflight and all existing JavaScript runtime/consumer checks passed for that candidate and its hosted legal URLs.

The signed workflow now runs the isolated Loop-StoreKitValidation scheme before archive. It exercises native StoreKit product loading, purchase, entitlement restoration through a new store instance, refund and expiration using Apple’s local test environment. This does not establish physical-device or TestFlight Sandbox purchase results. [Signed build #2](https://codemagic.io/app/6aafdf04d83de4e2e8943b2e/build/6ab029e6336d80bcce93430f) completed successfully for commit `64e4505d386d9c09e00461f2574acedf4b5430b5`, producing version **1.0.0 (102)**. All three native StoreKit tests passed with zero failures. Apple returned **UPLOAD SUCCEEDED with no errors** at 18:50 UTC. Delivery UUID: `06be58c6-fe0a-449c-a44e-a17483705e00`. App Store Connect subsequently completed processing, marked build 102 Ready to Submit, and the build was selected and saved on iOS version 1.0. The uploaded Loop icon was visually verified in Apple’s Included Assets viewer.

The release workflow pins Xcode 26.2 because the previous default iOS 26.5 simulator failed to configure StoreKitTest (SKInternalErrorDomain Code 3). The same tests passed on iOS 26.2 without changing purchase code. See [Apple's discussion](https://developer.apple.com/forums/thread/826364) and [Codemagic's installed runtimes](https://docs.codemagic.io/specs-macos/xcode-26-2/).

## Final-domain signed candidate 103 — 20 September 2026

Build 103 sets `privacyURL` to https://looptech.app/privacy/ and `termsURL` to https://looptech.app/terms/. The App Store version description, support URL https://looptech.app/support/ and marketing URL https://looptech.app/ are saved with the final domain. The Privacy Policy URL was also saved and verified on a fresh App Store Connect page. The review contact, including telephone, is saved as Daniel Vernon, request@flyopal.com, +442034323492.

Website version 4 is published. Both looptech.app and www.looptech.app have active SSL, and the root, www, support, privacy, terms and sitemap URLs returned HTTPS 200.

Both final-domain legal pages returned HTTPS 200 with the expected Loop/OPAL content using the release-preflight request configuration. The offline build, unsigned preflight, unchanged distribution preflight, runtime checks and all 11 consumer checks passed for the final-domain source configuration.

[Signed build #3](https://codemagic.io/app/6aafdf04d83de4e2e8943b2e/build/6ab03a637623b5e95f995ad6) completed successfully for commit `f9fd0728cc737dbd96a1ed3ee04f8df2a6872a90`, producing version **1.0.0 (103)** with the final-domain legal URLs. All three native local StoreKit tests passed with zero failures: purchase and entitlement after store recreation, expiration, and refund. Apple returned **UPLOAD SUCCEEDED with no errors**. Delivery UUID: `359027a3-b9d7-4b16-b536-8e0c63bfb492`. App Store Connect completed processing and marked build 103 Ready to Submit. Build 102 was removed from the version attachment, and build 103 was selected and saved on iOS version 1.0. The build 103 row was present with Save disabled, confirming the saved state. It has not been submitted for App Review. These local tests do not establish physical-device or TestFlight Sandbox purchase results.

### Review preparation status

- Saved: free download price, availability in all 175 selectable regions, age rating 4+, and five correctly sized screenshots each for iPhone and iPad, ordered 01–05.
- Saved: Full Access annual subscription pricing, localization, review screenshot and review notes. The subscription is added to the draft review submission (Ready for Review).
- Saved: description, support URL, marketing URL and Privacy Policy URL updated to the final domain, looptech.app; the Privacy Policy URL was verified on a fresh page. The review contact includes the supplied telephone +442034323492. Keywords and copyright remain saved.
- Draft saved, not published: Data Not Collected privacy answers. Publishing requires the owner to confirm Apple's accuracy/compliance declaration.
- Pending owner confirmation: rights or legally permitted use for third-party brand assets/content.
- Apple Business status verified on a fresh page: business information is being verified; the bank-account banner asks to add a bank account; the Paid Apps Agreement is Pending User Info. Both US tax forms and Digital Services Act information are Active.
- Not submitted for App Review. Published App Privacy answers and Content Rights Information remain required; the review contact is saved. Build 103 is processed, attached and saved on iOS version 1.0. Add the app version to the existing draft submission with the first subscription once the remaining requirements are complete.
