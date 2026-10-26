import SwiftUI

@main
struct CrewApp: App {
  @StateObject private var crew = CrewModel()

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(crew)
        .environmentObject(crew.glasses)
        .onAppear {
          crew.glasses.configure()
          crew.glasses.listenForLaunch()
        }
        .onOpenURL { url in Task { await crew.glasses.handle(url: url) } }
    }
  }
}
