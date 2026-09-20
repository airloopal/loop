import Foundation

enum NavigationPolicy {
    static func isTrustedDocument(_ url: URL?, indexURL: URL) -> Bool {
        guard let url, url.isFileURL else { return false }
        return url.standardizedFileURL.resolvingSymlinksInPath().path ==
            indexURL.standardizedFileURL.resolvingSymlinksInPath().path
    }

    static func externalURL(_ raw: String) -> URL? {
        guard raw.count <= 8192,
              !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              components.user == nil, components.password == nil,
              let url = components.url else { return nil }
        if scheme == "https" {
            guard let host = components.host, !host.isEmpty else { return nil }
            return url
        }
        if scheme == "mailto" {
            let address = components.path
            guard address.range(of: #"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$"#, options: .regularExpression) != nil,
                  components.queryItems?.allSatisfy({ ["subject", "body"].contains($0.name.lowercased()) }) ?? true
            else { return nil }
            return url
        }
        return nil
    }
}
