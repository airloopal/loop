# iOS release setup

Prepared against the current local source. This is a setup guide, not evidence of a successful Xcode build or an Apple approval.

## Repository and Codemagic

Use [airloopal/loop](https://github.com/airloopal/loop), with this directory at its root and branch `main`. The reference project is `airloopal/one-more-floor`; its build conventions were recovered from its local source. Do not put Loop into that app's bundle ID or overwrite its App Store record.

In Codemagic, import or select the GitHub repository **airloopal/loop**, choose branch **main**, use the root `codemagic.yaml`, and select **ios-validate**. Import, build execution and Apple configuration remain separate setup steps. The validation workflow builds the offline bundle, runs structural preflight, generates the Xcode project, compiles an unsigned simulator app and runs the native persistence/navigation tests on an available iPhone simulator. That `.app` runs in Simulator; it cannot be installed on a physical iPhone as an IPA.

For **ios-testflight**, replace these values:

| Location | Required value |
|---|---|
| `app/app-config.json` → `bundleID` | Proposed `com.littlesteps.techhelp`; confirm it is available in your Apple team. |
| `ios/project.yml` and `codemagic.yaml` | The same bundle identifier. |
| Codemagic `integrations.app_store_connect` | Exact existing integration name, if it has access to Loop. The reference project's name is `One More Floor`; this package deliberately requires you to select the correct connection. |
| Codemagic `APP_STORE_APPLE_ID` | Numeric Apple ID of the new Loop App Store Connect record. |
| Codemagic signing identities | Valid Apple Distribution certificate and a new App Store profile for the Loop bundle ID. |
| `LS_BUILD_OFFSET` | A value making the next CI build number greater than all previous Loop uploads. |

The previous certificate reference `one_more_floor_distribution` may be reusable if it belongs to the same active Apple team and its private key remains available in Codemagic. Its availability has not been verified. A One More Floor provisioning profile cannot sign Loop; create or fetch the profile for the new bundle ID.

The signed workflow performs `--distribution` checks, increments the build version, applies profiles, archives, and uploads to App Store Connect. It does not automatically submit to beta review or App Store review. After Apple processes the build, assign internal TestFlight testers in App Store Connect. Do not select that workflow until the first unsigned build and configuration checks have passed.

## Full Access subscription

Create one auto-renewable subscription in the Loop app's subscription group:

| Field | Value |
|---|---|
| Reference/display name | Full Access |
| Product ID | `com.littlesteps.techhelp.fullaccess.annual` |
| Duration | 1 year |
| Intended US price | $49.99 per year |
| Included content | The available advanced troubleshooting guides for supported devices/apps; basic checks and My Tech stay free. |

Set up that product, territories, localization and review material in App Store Connect, and complete the applicable paid-app agreements, tax and banking details there. A local `.storekit` file does not create the live product. Keep `purchasesEnabled` false until the product and native flow are ready for testing; enable it for the configured Sandbox/TestFlight build. Product price must come from StoreKit, and unavailable product data must leave the purchase button unavailable.

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
