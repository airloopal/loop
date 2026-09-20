import Foundation
import StoreKit
import UIKit

@MainActor
final class SubscriptionStore {
    struct Snapshot {
        var status: String
        var price: String?
        var productId: String
        var expirationDate: Date?
        var outcome: String?
        var message: String?

        var dictionary: [String: Any] {
            var result: [String: Any] = [
                "status": status, "price": price as Any? ?? NSNull(),
                "period": "year", "productId": productId,
                "expirationDate": expirationDate.map { ISO8601DateFormatter().string(from: $0) } as Any? ?? NSNull()
            ]
            if let outcome { result["outcome"] = outcome }
            if let message { result["message"] = message }
            return result
        }
    }

    let configuration: AppConfiguration
    var onChange: ((Snapshot) -> Void)?
    private var product: Product?
    private var updatesTask: Task<Void, Never>?
    private var expirationTask: Task<Void, Never>?
    private var purchaseInProgress = false
    private var lastPublishedSignature: String?

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        updatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                guard let self, !Task.isCancelled else { return }
                // Unverified data can never grant access. A fresh read also
                // removes access following refunds or revocations.
                if case .verified(let transaction) = result,
                   transaction.productID == self.configuration.productID {
                    _ = await self.snapshot()
                    await transaction.finish()
                } else {
                    _ = await self.snapshot()
                }
            }
        }
    }

    deinit {
        updatesTask?.cancel()
        expirationTask?.cancel()
    }

    func snapshot() async -> Snapshot {
        guard configuration.canUsePurchases else {
            return publish(Snapshot(status: "unavailable", productId: configuration.productID,
                message: "Full Access purchases are not available yet. Free help is ready to use."))
        }
        if product == nil {
            do {
                let products = try await Product.products(for: [configuration.productID])
                // Refuse a misconfigured non-annual or non-subscription product.
                product = products.first { candidate in
                    candidate.id == configuration.productID && candidate.type == .autoRenewable &&
                    candidate.subscription?.subscriptionPeriod.unit == .year &&
                    candidate.subscription?.subscriptionPeriod.value == 1
                }
            } catch {
                // A verified existing subscription still works if a fresh
                // storefront price cannot be fetched while offline.
            }
        }
        var activeExpiration: Date?
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  transaction.productID == configuration.productID,
                  transaction.productType == .autoRenewable,
                  transaction.revocationDate == nil,
                  !transaction.isUpgraded,
                  let expiration = transaction.expirationDate
            else { continue }
            if expiration > Date() {
                activeExpiration = max(activeExpiration ?? .distantPast, expiration)
            } else if let grace = await graceExpiration(for: transaction) {
                activeExpiration = max(activeExpiration ?? .distantPast, grace)
            }
        }
        scheduleExpiration(activeExpiration)
        let status = activeExpiration != nil ? "active" : (product == nil ? "unavailable" : "inactive")
        return publish(Snapshot(status: status, price: product?.displayPrice,
            productId: configuration.productID, expirationDate: activeExpiration,
            message: status == "unavailable" ? "The App Store could not load Full Access. Check your connection and try again." : nil))
    }

    func purchase() async -> Snapshot {
        let before = await snapshot()
        guard configuration.canUsePurchases, let product else { return before }
        if before.status == "active" { return before }
        guard !purchaseInProgress else {
            return withOutcome(before, "pending", "A purchase is already in progress.")
        }
        purchaseInProgress = true
        defer { purchaseInProgress = false }
        do {
            switch try await product.purchase() {
            case .success(let result):
                guard case .verified(let transaction) = result,
                      transaction.productID == configuration.productID,
                      transaction.revocationDate == nil,
                      !transaction.isUpgraded,
                      let expiration = transaction.expirationDate, expiration > Date()
                else {
                    return withOutcome(await snapshot(), "error", "Apple could not verify this purchase. Use Restore purchases or try again.")
                }
                let verified = await snapshot()
                await transaction.finish()
                return withOutcome(verified, verified.status == "active" ? "purchased" : "pending",
                    verified.status == "active" ? nil : "Your purchase is processing. Access will update once Apple confirms it.")
            case .pending:
                return withOutcome(await snapshot(), "pending", "Your purchase is awaiting approval. We will update access when Apple confirms it.")
            case .userCancelled:
                return withOutcome(await snapshot(), "cancelled", "Purchase cancelled. You have not been charged by this action.")
            @unknown default:
                return withOutcome(await snapshot(), "error", "The purchase could not be completed. Please try again.")
            }
        } catch {
            return withOutcome(await snapshot(), "error", "The App Store could not complete your purchase. Please try again.")
        }
    }

    func restore() async -> Snapshot {
        guard configuration.canUsePurchases else { return await snapshot() }
        do {
            // Sync is only invoked after an explicit Restore purchases tap.
            try await AppStore.sync()
            let restored = await snapshot()
            return withOutcome(restored, "restored", restored.status == "active"
                ? "Your Full Access subscription has been restored."
                : "No active Full Access subscription was found for this Apple Account.")
        } catch {
            return withOutcome(await snapshot(), "error", "Purchases could not be restored. Check your connection and try again.")
        }
    }

    func manage(in scene: UIWindowScene) async throws {
        try await AppStore.showManageSubscriptions(in: scene)
        _ = await snapshot()
    }

    private func withOutcome(_ snapshot: Snapshot, _ outcome: String, _ message: String?) -> Snapshot {
        var result = snapshot
        result.outcome = outcome
        result.message = message
        return publish(result)
    }

    @discardableResult
    private func publish(_ value: Snapshot) -> Snapshot {
        // A notification prompts JavaScript to ask StoreKit again. Emitting on
        // every read would create a refresh loop, so notify only on a change.
        let signature = "\(value.status)|\(value.price ?? "")|\(value.productId)|\(value.expirationDate?.timeIntervalSince1970 ?? 0)"
        if signature != lastPublishedSignature {
            lastPublishedSignature = signature
            onChange?(value)
        }
        return value
    }

    private func graceExpiration(for transaction: Transaction) async -> Date? {
        // Existing billing grace must not depend on successfully fetching fresh
        // storefront product metadata during an offline cold launch.
        guard let groupID = transaction.subscriptionGroupID,
              let statuses = try? await Product.SubscriptionInfo.status(for: groupID)
        else { return nil }
        for status in statuses where status.state == .inGracePeriod {
            guard case .verified(let statusTransaction) = status.transaction,
                  statusTransaction.productID == configuration.productID,
                  statusTransaction.originalID == transaction.originalID,
                  statusTransaction.revocationDate == nil,
                  !statusTransaction.isUpgraded,
                  case .verified(let renewal) = status.renewalInfo,
                  let graceEnd = renewal.gracePeriodExpirationDate,
                  graceEnd > Date()
            else { continue }
            return graceEnd
        }
        return nil
    }

    private func scheduleExpiration(_ expiration: Date?) {
        expirationTask?.cancel()
        guard let expiration else { return }
        let delay = max(0.2, expiration.timeIntervalSinceNow + 0.2)
        expirationTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) }
            catch { return }
            guard !Task.isCancelled else { return }
            _ = await self?.snapshot()
        }
    }
}
