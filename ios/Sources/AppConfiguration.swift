import Foundation

struct AppConfiguration: Decodable {
    let productID: String
    let purchasesEnabled: Bool
    let supportEmail: String?
    let privacyURL: String?
    let termsURL: String?

    static func load() -> AppConfiguration {
        let fallback = AppConfiguration(
            productID: "com.littlesteps.techhelp.fullaccess.annual",
            purchasesEnabled: false, supportEmail: nil, privacyURL: nil, termsURL: nil
        )
        guard let url = Bundle.main.url(forResource: "AppConfig", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let configuration = try? JSONDecoder().decode(Self.self, from: data)
        else { return fallback }
        return configuration
    }

    var canUsePurchases: Bool {
        #if DEBUG
        // Only the explicitly selected local StoreKit testing scheme sets this.
        if ProcessInfo.processInfo.environment["LITTLE_STEPS_STOREKIT_TESTING"] == "1" {
            return true
        }
        #endif
        return purchasesEnabled && !productID.isEmpty
    }
}
