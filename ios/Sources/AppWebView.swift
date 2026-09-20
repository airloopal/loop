import SwiftUI
import WebKit
import SafariServices

@MainActor
struct AppWebView: UIViewRepresentable {
    @ObservedObject var model: AppModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "littleSteps")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(named: "LaunchBackground")
        webView.scrollView.backgroundColor = UIColor(named: "LaunchBackground")
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        context.coordinator.webView = webView
        context.coordinator.load(reloadID: model.reloadID)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.reloadID != model.reloadID {
            context.coordinator.load(reloadID: model.reloadID)
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "littleSteps", contentWorld: .page)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
        let model: AppModel
        weak var webView: WKWebView?
        var reloadID: UUID?
        private let stateStore = LocalStateStore()
        private let indexURL = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Web")
        private var documentReady = false

        init(model: AppModel) {
            self.model = model
            super.init()
            model.subscriptions.onChange = { [weak self] snapshot in
                self?.emitSubscription(snapshot)
            }
        }

        func load(reloadID: UUID) {
            self.reloadID = reloadID
            documentReady = false
            guard let indexURL else {
                model.isLoading = false
                model.loadError = "Your offline guides are missing. Please install the latest version of Loop."
                return
            }
            webView?.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())
        }

        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage,
                                   replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
            guard message.name == "littleSteps", message.frameInfo.isMainFrame,
                  let indexURL, message.webView === webView,
                  NavigationPolicy.isTrustedDocument(message.frameInfo.request.url, indexURL: indexURL),
                  NavigationPolicy.isTrustedDocument(webView?.url, indexURL: indexURL),
                  let body = message.body as? [String: Any], let action = body["action"] as? String
            else { replyHandler(nil, "This page cannot use the app bridge."); return }
            let payload = body["payload"] as? [String: Any] ?? [:]
            Task { @MainActor in
                do {
                    let response = try await handle(action: action, payload: payload)
                    replyHandler(response, nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }
        }

        private func handle(action: String, payload: [String: Any]) async throws -> [String: Any] {
            switch action {
            case "loadState":
                let state = try stateStore.load()
                return ["state": state as Any? ?? NSNull()]
            case "saveState":
                guard let state = payload["state"] as? [String: Any] else { throw BridgeError.invalidRequest }
                try stateStore.save(state)
                return ["ok": true]
            case "clearState":
                stateStore.clear()
                return ["ok": true]
            case "getSubscription": return await model.subscriptions.snapshot().dictionary
            case "purchase": return await model.subscriptions.purchase().dictionary
            case "restore": return await model.subscriptions.restore().dictionary
            case "manageSubscription":
                guard !ProcessInfo.processInfo.isiOSAppOnMac,
                      let scene = webView?.window?.windowScene else { throw BridgeError.presentationUnavailable }
                try await model.subscriptions.manage(in: scene)
                return ["ok": true]
            case "shareSummary":
                guard let text = payload["text"] as? String, !text.isEmpty, text.count <= 50_000,
                      let presenter = presenter() else { throw BridgeError.invalidRequest }
                let controller = UIActivityViewController(activityItems: [text], applicationActivities: nil)
                if let title = payload["title"] as? String { controller.setValue(String(title.prefix(200)), forKey: "subject") }
                controller.popoverPresentationController?.sourceView = presenter.view
                controller.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
                controller.popoverPresentationController?.permittedArrowDirections = []
                presenter.present(controller, animated: true)
                return ["ok": true]
            case "openURL":
                guard let raw = payload["url"] as? String, let url = NavigationPolicy.externalURL(raw) else { throw BridgeError.invalidURL }
                try openExternal(url)
                return ["ok": true]
            case "getAppInfo":
                return ["version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0",
                        "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"]
            default: throw BridgeError.invalidRequest
            }
        }

        private func presenter() -> UIViewController? {
            guard var controller = webView?.window?.rootViewController else { return nil }
            while let presented = controller.presentedViewController { controller = presented }
            guard !controller.isBeingDismissed else { return nil }
            return controller
        }

        private func openExternal(_ url: URL) throws {
            if url.scheme?.lowercased() == "mailto" {
                guard UIApplication.shared.canOpenURL(url) else { throw BridgeError.noMailApp }
                UIApplication.shared.open(url)
            } else {
                guard let presenter = presenter() else { throw BridgeError.presentationUnavailable }
                presenter.present(SFSafariViewController(url: url), animated: true)
            }
        }

        private func emitSubscription(_ snapshot: SubscriptionStore.Snapshot) {
            guard documentReady, let webView, let indexURL,
                  NavigationPolicy.isTrustedDocument(webView.url, indexURL: indexURL) else { return }
            // Pass JSON as an argument, never interpolate strings into source.
            webView.callAsyncJavaScript(
                "window.dispatchEvent(new CustomEvent('littleStepsSubscriptionChanged', {detail: subscription}));",
                arguments: ["subscription": snapshot.dictionary], in: nil, in: .page,
                completionHandler: { _ in }
            )
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if navigationAction.targetFrame?.isMainFrame == true, let indexURL,
               NavigationPolicy.isTrustedDocument(url, indexURL: indexURL) {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                if navigationAction.sourceFrame.isMainFrame, let indexURL,
                   NavigationPolicy.isTrustedDocument(navigationAction.sourceFrame.request.url, indexURL: indexURL),
                   let external = NavigationPolicy.externalURL(url.absoluteString) {
                    try? openExternal(external)
                }
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // New windows never inherit a native bridge.
            if navigationAction.sourceFrame.isMainFrame, let indexURL,
               NavigationPolicy.isTrustedDocument(navigationAction.sourceFrame.request.url, indexURL: indexURL),
               let url = navigationAction.request.url,
               let external = NavigationPolicy.externalURL(url.absoluteString) { try? openExternal(external) }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            documentReady = true
            model.isLoading = false
            model.loadError = nil
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            documentReady = false
            model.isLoading = false
            model.loadError = "Loop needs to reload. Your saved devices and progress are still on this device."
        }

        private func failed(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            documentReady = false
            model.isLoading = false
            model.loadError = "Your guides could not open. Try loading them again — an internet connection is not needed for basic help."
        }

        enum BridgeError: LocalizedError {
            case invalidRequest, invalidURL, presentationUnavailable, noMailApp
            var errorDescription: String? {
                switch self {
                case .invalidRequest: return "This app request could not be completed."
                case .invalidURL: return "This link is not supported."
                case .presentationUnavailable: return "This screen is not available right now. Please try again."
                case .noMailApp: return "No email app is available. Copy the support address into your preferred email service."
                }
            }
        }
    }
}
