import SwiftUI

struct ContentView: View {
  @EnvironmentObject var crew: CrewModel
  @EnvironmentObject var glasses: Glasses
  @State private var typed = ""
  @State private var showSettings = false

  var body: some View {
    NavigationStack {
      List {
        Section("Glasses") {
          HStack {
            Text(status)
            Spacer()
            switch glasses.link {
            case .notRegistered: Button("Register") { Task { await glasses.register() } }
            case .failed:
              VStack(alignment: .trailing, spacing: 8) {
                Button("Try again") { Task { await glasses.connect() } }.buttonStyle(.borderedProminent)
                Button("Register") { Task { await glasses.register() } }.font(.footnote)
              }
            case .registered: Button("Connect") { Task { await glasses.connect() } }
            case .connected: Button("Disconnect", role: .destructive) { glasses.disconnect() }
            default: ProgressView()
            }
          }
          if !glasses.heard.isEmpty { Text("Heard: \(glasses.heard)").font(.footnote).foregroundStyle(.secondary) }
          Text("Say \"crew, ...\" or press the capture button to start or end a shopping trip.")
            .font(.footnote).foregroundStyle(.secondary)
        }

        Section("Ask") {
          Picker("Mode", selection: $crew.mode) {
            ForEach(CrewModel.modes, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")) }
          }
          HStack {
            TextField("What do you need?", text: $typed).onSubmit(send)
            Button("Send", action: send).disabled(typed.isEmpty || crew.busy)
          }
          Button(crew.shopping ? "End shopping trip" : "Start shopping trip") {
            Task { crew.shopping ? await crew.endShopping() : await crew.startShopping() }
          }
          if crew.waitingForApproval {
            HStack {
              Button("Yes") { crew.approve(true) }.buttonStyle(.borderedProminent)
              Button("No") { crew.approve(false) }.buttonStyle(.bordered)
            }
          }
        }

        Section("Conversation") {
          ForEach(crew.lines.reversed()) { line in
            VStack(alignment: .leading, spacing: 2) {
              Text(line.who).font(.caption).foregroundStyle(.secondary)
              Text(line.text)
            }
          }
        }

        if !crew.steps.isEmpty {
          Section("What the crew did") {
            ForEach(Array(crew.steps.enumerated()), id: \.offset) { _, s in
              Text(s).font(.system(.footnote, design: .monospaced))
            }
          }
        }
      }
      .navigationTitle("Kitchen Crew")
      .toolbar { Button { showSettings = true } label: { Image(systemName: "gearshape") } }
      .sheet(isPresented: $showSettings) { SettingsView() }
    }
  }

  private var status: String {
    switch glasses.link {
    case .notRegistered: "Not registered"
    case .registering: "Registering in Meta AI"
    case .registered: "Registered"
    case .connecting: "Connecting"
    case .connected: glasses.cameraOn ? "Connected, camera on" : "Connected"
    case let .failed(why): why
    }
  }

  private func send() {
    let t = typed
    typed = ""
    Task { await crew.ask(t) }
  }
}

struct SettingsView: View {
  @EnvironmentObject var crew: CrewModel
  @Environment(\.dismiss) var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section("Crew service") {
          TextField("https://crew.example.com", text: $crew.serverURL)
            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
          SecureField("App token", text: $crew.appToken)
        }
        Section {
          Text("Camera frames go to the crew service to name the item in your hand, and are not saved anywhere.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Settings")
      .toolbar { Button("Done") { dismiss() } }
    }
  }
}
