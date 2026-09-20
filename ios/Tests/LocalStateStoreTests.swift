import XCTest
@testable import LittleSteps

final class LocalStateStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var store: LocalStateStore!

    override func setUp() {
        super.setUp()
        suiteName = "LittleStepsTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        store = LocalStateStore(defaults: defaults)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        store = nil
        defaults = nil
        super.tearDown()
    }

    private var state: [String: Any] {
        ["schemaVersion": 1, "savedProfiles": [["model": "iphone-16", "nickname": "My phone"]],
         "guideProgress": ["iphone-wifi": ["step": 2]], "lastAdvancedGuide": NSNull(),
         "language": "en", "onboardingComplete": true, "updatedAt": "2026-09-19T20:00:00Z"]
    }

    func testDeviceAndGuideStateSurvivesStoreRecreation() throws {
        try store.save(state)
        let reloaded = try XCTUnwrap(LocalStateStore(defaults: defaults).load())
        XCTAssertEqual(reloaded["language"] as? String, "en")
        XCTAssertEqual((reloaded["savedProfiles"] as? [[String: String]])?.first?["nickname"], "My phone")
    }

    func testAccessClaimsCannotBePersistedAtAnyDepth() {
        var invalid = state
        invalid["previewAccess"] = true
        XCTAssertThrowsError(try store.save(invalid))
        invalid = state
        invalid["guideProgress"] = ["guide": ["facts": ["entitlement": "active"]]]
        XCTAssertThrowsError(try store.save(invalid))
    }

    func testMalformedAndOversizedStateCannotReplaceSavedDevices() throws {
        try store.save(state)
        var invalid = state
        invalid["savedProfiles"] = "not an array"
        XCTAssertThrowsError(try store.save(invalid))
        invalid = state
        invalid["savedProfiles"] = [["nickname": String(repeating: "A", count: 1_048_577)]]
        XCTAssertThrowsError(try store.save(invalid))
        XCTAssertEqual((try store.load()?["savedProfiles"] as? [[String: String]])?.first?["nickname"], "My phone")
    }

    func testClearOnlyRemovesLittleStepsState() throws {
        defaults.set("preserved", forKey: "unrelated")
        try store.save(state)
        store.clear()
        XCTAssertNil(try store.load())
        XCTAssertEqual(defaults.string(forKey: "unrelated"), "preserved")
    }
}
