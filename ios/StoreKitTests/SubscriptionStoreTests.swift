import StoreKit
import StoreKitTest
import XCTest
@testable import LittleSteps

/// Exercises the production StoreKit implementation against Apple's local test
/// environment. This is not App Store Sandbox or TestFlight transaction testing.
/// The test configuration is bundled only in LoopStoreKitTests, never in the app.
final class SubscriptionStoreTests: XCTestCase {
    private let productID = "com.littlesteps.techhelp.fullaccess.annual"

    @MainActor
    private func makeSession() throws -> SKTestSession {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "FullAccess", withExtension: "storekit"))
        let session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
        return session
    }

    @MainActor
    private func makeStore() -> SubscriptionStore {
        // Inject only this test instance's configuration; no launch argument,
        // application setting or production entitlement is changed.
        SubscriptionStore(configuration: AppConfiguration(
            productID: productID, purchasesEnabled: true,
            supportEmail: nil, privacyURL: nil, termsURL: nil
        ))
    }

    @MainActor
    private func waitForStatus(_ expected: String, in store: SubscriptionStore,
                               file: StaticString = #filePath, line: UInt = #line) async throws -> SubscriptionStore.Snapshot {
        let deadline = Date().addingTimeInterval(10)
        var result = await store.snapshot()
        while result.status != expected && Date() < deadline {
            try await Task.sleep(nanoseconds: 200_000_000)
            result = await store.snapshot()
        }
        XCTAssertEqual(result.status, expected, result.message ?? "Unexpected entitlement state", file: file, line: line)
        return result
    }

    @MainActor
    func testAnnualProductPurchaseAndEntitlementAfterStoreRecreation() async throws {
        let session = try makeSession()
        defer { session.clearTransactions(); session.resetToDefaultState() }

        let products = try await Product.products(for: [productID])
        let product = try XCTUnwrap(products.first { $0.id == productID })
        XCTAssertEqual(product.type, .autoRenewable)
        let subscription = try XCTUnwrap(product.subscription)
        XCTAssertEqual(subscription.subscriptionPeriod.unit, .year)
        XCTAssertEqual(subscription.subscriptionPeriod.value, 1)
        XCTAssertEqual(product.price, Decimal(4999) / 100)
        XCTAssertFalse(product.displayPrice.isEmpty)

        let store = makeStore()
        let before = try await waitForStatus("inactive", in: store)
        XCTAssertEqual(before.price, product.displayPrice)
        XCTAssertNil(before.expirationDate)

        // Exercise SubscriptionStore.purchase(), including Product.purchase()
        // and Apple's transaction verification, without a mocked bridge.
        let purchase = await store.purchase()
        XCTAssertTrue(["purchased", "pending"].contains(purchase.outcome ?? ""),
                      purchase.message ?? "The native purchase did not complete")
        let active = try await waitForStatus("active", in: store)
        XCTAssertEqual(active.productId, productID)
        XCTAssertGreaterThan(try XCTUnwrap(active.expirationDate), Date())

        let recreated = makeStore()
        let restored = try await waitForStatus("active", in: recreated)
        XCTAssertEqual(restored.expirationDate, active.expirationDate)
        XCTAssertEqual(restored.price, product.displayPrice)
    }

    @MainActor
    func testRefundRemovesAccess() async throws {
        let session = try makeSession()
        defer { session.clearTransactions(); session.resetToDefaultState() }
        let store = makeStore()
        _ = try await waitForStatus("inactive", in: store)
        try session.buyProduct(productIdentifier: productID)
        _ = try await waitForStatus("active", in: store)

        let transaction = try XCTUnwrap(session.allTransactions().last { $0.productIdentifier == productID })
        try session.refundTransaction(identifier: transaction.identifier)
        let refunded = try await waitForStatus("inactive", in: store)
        XCTAssertNil(refunded.expirationDate)
        let afterRecreation = try await waitForStatus("inactive", in: makeStore())
        XCTAssertNil(afterRecreation.expirationDate)
    }

    @MainActor
    func testExpirationRemovesAccess() async throws {
        let session = try makeSession()
        defer { session.clearTransactions(); session.resetToDefaultState() }
        let store = makeStore()
        _ = try await waitForStatus("inactive", in: store)
        try session.buyProduct(productIdentifier: productID)
        _ = try await waitForStatus("active", in: store)

        try session.expireSubscription(productIdentifier: productID)
        let expired = try await waitForStatus("inactive", in: store)
        XCTAssertNil(expired.expirationDate)
        let afterRecreation = try await waitForStatus("inactive", in: makeStore())
        XCTAssertNil(afterRecreation.expirationDate)
    }
}
