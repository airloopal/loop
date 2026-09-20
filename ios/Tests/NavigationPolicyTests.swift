import XCTest
@testable import LittleSteps

final class NavigationPolicyTests: XCTestCase {
    func testOnlyExactBundledFileMayUseBridge() {
        let index = URL(fileURLWithPath: "/private/App/Web/index.html")
        XCTAssertTrue(NavigationPolicy.isTrustedDocument(index, indexURL: index))
        XCTAssertTrue(NavigationPolicy.isTrustedDocument(URL(string: "file:///private/App/Web/index.html#help"), indexURL: index))
        XCTAssertFalse(NavigationPolicy.isTrustedDocument(URL(string: "https://example.com/index.html"), indexURL: index))
        XCTAssertFalse(NavigationPolicy.isTrustedDocument(URL(fileURLWithPath: "/private/App/Web/other.html"), indexURL: index))
        XCTAssertFalse(NavigationPolicy.isTrustedDocument(URL(fileURLWithPath: "/private/App/Web/../index.html"), indexURL: index))
        XCTAssertFalse(NavigationPolicy.isTrustedDocument(nil, indexURL: index))
    }

    func testExternalLinksRequireHTTPSOrSingleValidatedEmail() {
        XCTAssertNotNil(NavigationPolicy.externalURL("https://support.apple.com/en-us/HT204051"))
        XCTAssertNotNil(NavigationPolicy.externalURL("mailto:help@example.com?subject=Little%20Steps"))
        for invalid in ["javascript:alert(1)", "file:///private/app/index.html", "http://example.com", "https://user:password@example.com", "https://", "mailto:bad", "mailto:a@example.com,b@example.com", "mailto:a@example.com?bcc=other@example.com", "mailto:a%0d%0ab@example.com"] {
            XCTAssertNil(NavigationPolicy.externalURL(invalid), invalid)
        }
    }
}
