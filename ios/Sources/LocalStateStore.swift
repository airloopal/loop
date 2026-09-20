import Foundation

/// This stores device preferences and guide progress only. It never stores or
/// supplies a subscription decision; StoreKit is the sole entitlement authority.
struct LocalStateStore {
    private let key = "littleSteps.consumerState.v1"
    private let maximumBytes = 1_048_576
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func load() throws -> [String: Any]? {
        guard let data = defaults.data(forKey: key) else { return nil }
        guard data.count <= maximumBytes,
              let state = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw StateError.invalid }
        try validate(state)
        return state
    }

    func save(_ state: [String: Any]) throws {
        try validate(state)
        let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
        guard data.count <= maximumBytes else { throw StateError.tooLarge }
        defaults.set(data, forKey: key)
    }

    func clear() { defaults.removeObject(forKey: key) }

    private func validate(_ state: [String: Any]) throws {
        let allowed: Set<String> = ["schemaVersion", "savedProfiles", "guideProgress",
            "lastAdvancedGuide", "language", "onboardingComplete", "updatedAt"]
        guard Set(state.keys).isSubset(of: allowed),
              state["schemaVersion"] as? Int == 1,
              state["savedProfiles"] is [[String: Any]],
              state["guideProgress"] is [String: Any],
              state["language"] is String,
              state["onboardingComplete"] is Bool,
              state["updatedAt"] is String,
              state["lastAdvancedGuide"] == nil || state["lastAdvancedGuide"] is NSNull || state["lastAdvancedGuide"] is String,
              JSONSerialization.isValidJSONObject(state),
              !containsAccessKey(state)
        else { throw StateError.invalid }
    }

    private func containsAccessKey(_ value: Any) -> Bool {
        let forbidden: Set<String> = ["previewaccess", "subscription", "entitlement",
            "entitlements", "ispremium", "fullaccess", "paidaccess"]
        if let object = value as? [String: Any] {
            return object.contains { forbidden.contains($0.key.lowercased()) || containsAccessKey($0.value) }
        }
        if let values = value as? [Any] { return values.contains(where: containsAccessKey) }
        return false
    }

    enum StateError: LocalizedError {
        case invalid, tooLarge
        var errorDescription: String? {
            switch self {
            case .invalid: return "The saved app data is not in a supported format."
            case .tooLarge: return "Your saved app data is too large. Remove an unused saved device and try again."
            }
        }
    }
}
