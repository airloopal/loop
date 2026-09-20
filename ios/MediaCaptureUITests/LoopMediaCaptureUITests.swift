import XCTest

/// Exercises the shipping UI. No injected state, paid entitlement or production test hook.
@MainActor
final class LoopMediaCaptureUITests: XCTestCase {
    private let app = XCUIApplication()
    private var web: XCUIElement { app.webViews.firstMatch }

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        XCTAssertTrue(web.waitForExistence(timeout: 30), "The bundled app must finish loading.")
    }

    override func record(_ issue: XCTIssue) {
        let hierarchy = app.debugDescription
        print("LOOP MEDIA FAILURE ACCESSIBILITY HIERARCHY\n\(hierarchy)")
        let attachment = XCTAttachment(string: hierarchy)
        attachment.name = "loop-media-failure-accessibility"
        attachment.lifetime = .keepAlways
        add(attachment)
        super.record(issue)
    }

    func testCaptureRealAppScreens() throws {
        // capture-app-media.py uninstalls only this app on the selected CI simulator first.
        try capture("01-welcome", heading: "Tech support, one tap at a time.")
        try tap("Let’s begin")
        try capture("02-home", heading: "Let’s get your tech working.")

        try tap("Phones & tablets")
        try capture("03-phone-brands", heading: "Which brand do you use?")
        try tap("Apple")
        try capture("04-apple-models", heading: "Which model do you have?")

        // Select a released device through the same visible controls a customer uses.
        try chooseModel("iPhone 16")
        try tap("iOS")
        try tap("Save to My Tech")
        try tap("My iPhone or iPad cannot use Wi-Fi")
        try capture("05-free-wifi-check", heading: "Open Wi-Fi settings")

        try tap("My Tech")
        let savedDevice = web.buttons.matching(NSPredicate(
            format: "label == %@", "Troubleshoot Apple · iPhone 16"
        )).firstMatch
        XCTAssertTrue(savedDevice.waitForExistence(timeout: 15), "My Tech must contain the device actually saved above.")
        try capture("06-my-tech", visibleElement: savedDevice)

        // This is the public coverage/intro screen, not an unlocked paid guide.
        try tap("Get help")
        try tap("More options")
        try tap("Explore Full Access")
        try tap("Browse guides")
        try tap("Find where your iPhone connection stops", prefix: true)
        try capture("07-advanced-guide-preview", heading: "Find where your iPhone connection stops")
    }

    private func element(named label: String, prefix: Bool = false) -> XCUIElement {
        let predicate = NSPredicate(format: prefix ? "label BEGINSWITH %@" : "label == %@", label)
        let button = web.buttons.matching(predicate).firstMatch
        if button.exists { return button }
        // A model button's accessibility label can also include its Full Access badge.
        // Its exact visible text remains a stable tap target without selecting a sibling model.
        return web.staticTexts.matching(predicate).firstMatch
    }

    private func tap(_ label: String, prefix: Bool = false) throws {
        let target = element(named: label, prefix: prefix)
        try tapElement(target, label: label)
    }

    private func tapElement(_ target: XCUIElement, label: String) throws {
        XCTAssertTrue(target.waitForExistence(timeout: 15), "Missing visible control: \(label)")
        for _ in 0..<8 where !target.isHittable { web.swipeUp() }
        // A previous long panel may have left us below a header control.
        for _ in 0..<8 where !target.isHittable { web.swipeDown() }
        XCTAssertTrue(target.isHittable, "Control must be reachable before tapping: \(label)")
        target.tap()
    }

    private func chooseModel(_ label: String) throws {
        // WebKit can flatten the main label and the separate coverage badge into
        // one button label: "iPhone 16 Full Access" (sometimes without a separator).
        // Accept only the exact model followed by its known metadata; a broad
        // beginsWith match would also incorrectly select iPhone 16 Pro or Plus.
        let escaped = NSRegularExpression.escapedPattern(for: label)
        let pattern = "^" + escaped + "(?:[\\s,·]*Full Access)?(?:[\\s,·]*New · [0-9]{4})?$"
        for _ in 0..<6 {
            let model = web.buttons.matching(NSPredicate(format: "label MATCHES %@", pattern)).firstMatch
            if model.exists {
                print("Selecting exact model control: \(model.label)")
                try tapElement(model, label: label)
                return
            }
            let exactText = web.staticTexts.matching(NSPredicate(format: "label == %@", label)).firstMatch
            if exactText.exists {
                try tapElement(exactText, label: label)
                return
            }
            let more = element(named: "Load More models and products")
            guard more.exists else { break }
            try tap("Load More models and products")
        }
        XCTFail("The released model must be available through the visible catalogue: \(label)")
    }

    private func capture(_ name: String, heading: String) throws {
        let title = web.staticTexts.matching(NSPredicate(format: "label == %@", heading)).firstMatch
        try capture(name, visibleElement: title)
    }

    private func capture(_ name: String, visibleElement: XCUIElement) throws {
        XCTAssertTrue(visibleElement.waitForExistence(timeout: 15), "Expected screen was not rendered: \(name)")
        for _ in 0..<6 where !visibleElement.isHittable { web.swipeDown() }
        XCTAssertTrue(visibleElement.isHittable, "The important screen content must be visible: \(name)")
        // Allow the production entrance transitions, font rendering and image decode to settle.
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertFalse(app.staticTexts["Getting your guides ready…"].exists)
        XCTAssertEqual(app.keyboards.count, 0, "Store screenshots must not contain a keyboard.")
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "loop-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
