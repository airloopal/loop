import SwiftUI
import Combine

@MainActor
final class AppModel: ObservableObject {
    @Published var isLoading = true
    @Published var loadError: String?
    @Published var reloadID = UUID()
    let subscriptions = SubscriptionStore(configuration: .load())

    func reload() {
        loadError = nil
        isLoading = true
        reloadID = UUID()
    }
}

@main
@MainActor
struct LittleStepsApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ZStack {
                Color("LaunchBackground").ignoresSafeArea()
                AppWebView(model: model)
                if model.isLoading || model.loadError != nil {
                    Color("LaunchBackground")
                    VStack(spacing: 20) {
                        Image(systemName: "sparkle")
                            .font(.system(size: 44, weight: .medium))
                            .foregroundStyle(Color(red: 0.78, green: 1.0, blue: 0.33))
                            .accessibilityHidden(true)
                        Text("Loop")
                            .font(.title.weight(.semibold))
                        if let error = model.loadError {
                            Text(error).font(.body).multilineTextAlignment(.center)
                            Button("Try again") { model.reload() }
                                .buttonStyle(.borderedProminent)
                                .tint(Color(red: 0.78, green: 1.0, blue: 0.33))
                                .foregroundStyle(.black)
                        } else {
                            ProgressView().tint(.primary)
                            Text("Getting your guides ready…").font(.subheadline)
                        }
                    }
                    .foregroundStyle(.primary)
                    .padding(32)
                    .accessibilityElement(children: .contain)
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    Task { _ = await model.subscriptions.snapshot() }
                }
            }
        }
    }
}
