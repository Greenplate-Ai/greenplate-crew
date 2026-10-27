import SwiftUI

// MARK: - Theme (GreenplateAi tokens, see ios/DESIGN.md)

enum Theme {
  static let green = Color(hex: 0x25A777)
  static let greenDeep = Color(hex: 0x186F50)
  static let forest = Color(hex: 0x0E2B1F)
  static let leaf = Color(hex: 0x4ECB37)
  static let tint = Color(hex: 0xD9F2E7)
  static let tint50 = Color(hex: 0xF3FAF6)
  static let ink = Color(hex: 0x202428)
  static let muted = Color(hex: 0x585E6A)
  static let line = Color(hex: 0xE2DFDA)
  static let canvas = Color(hex: 0xFBFAF9)
  static let forestText = Color(hex: 0xB9D6C6)
  static let warn = Color(hex: 0x8A3B2E)
  static let warnBg = Color(hex: 0xFCF7F6)
}

extension Color {
  init(hex: UInt32) {
    self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
  }
}

// MARK: - Root: four tabs

struct ContentView: View {
  @EnvironmentObject var glasses: Glasses
  @State private var tab = 0

  var body: some View {
    TabView(selection: $tab) {
      CrewView(openGlasses: { tab = 2 })
        .tabItem { Label("Crew", systemImage: "bubble.left.and.bubble.right") }
        .tag(0)
      ShoppingView(openGlasses: { tab = 2 })
        .tabItem { Label("Shopping", systemImage: "cart") }
        .tag(1)
      GlassesView()
        .tabItem { Label("Glasses", systemImage: "eyeglasses") }
        .tag(2)
      SettingsView()
        .tabItem { Label("Settings", systemImage: "gearshape") }
        .tag(3)
    }
    .tint(Theme.greenDeep)
    .onAppear { if !glasses.registered { tab = 2 } }
  }
}

// MARK: - Shared pieces

extension Glasses.Link {
  var title: String {
    switch self {
    case .notRegistered: "Glasses not set up"
    case .registering: "Registering in Meta AI"
    case .registered: "Ready to connect"
    case .connecting: "Connecting"
    case .connected: "Glasses connected"
    case .failed: "Couldn't connect"
    }
  }
}

/// The dark status bar at the top of Crew and Shopping. Tapping it opens the Glasses tab.
struct GlassesBar: View {
  @EnvironmentObject var glasses: Glasses
  var subtitle: String
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        Image(systemName: "eyeglasses").font(.title2).foregroundStyle(.white)
        VStack(alignment: .leading, spacing: 2) {
          Text(glasses.link.title).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
          Text(subtitle).font(.footnote).foregroundStyle(Theme.forestText).lineLimit(2)
        }
        Spacer()
        Circle().fill(glasses.link == .connected ? Theme.leaf : Theme.forestText.opacity(0.5)).frame(width: 10, height: 10)
      }
      .padding(16)
      .background(Theme.forest, in: RoundedRectangle(cornerRadius: 18))
    }
    .buttonStyle(.plain)
  }
}

struct Bubble: View {
  let line: CrewModel.Line
  var body: some View {
    let mine = line.who == "You"
    HStack {
      if mine { Spacer(minLength: 48) }
      Text(line.text)
        .font(.body)
        .foregroundStyle(mine ? Color(hex: 0x14402F) : Theme.ink)
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background(mine ? Theme.tint : .white, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(mine ? .clear : Theme.line, lineWidth: 1))
      if !mine { Spacer(minLength: 48) }
    }
  }
}

// MARK: - Crew tab

struct CrewView: View {
  @EnvironmentObject var crew: CrewModel
  @EnvironmentObject var glasses: Glasses
  var openGlasses: () -> Void
  @State private var typed = ""

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            GlassesBar(subtitle: glasses.link != .connected ? "Tap to set up your glasses" : (glasses.listening ? "Listening. Say \"crew, ...\"" : "Not listening right now. Restarting..."), action: openGlasses)
            if !glasses.heard.isEmpty {
              Text("Heard: \(glasses.heard)").font(.footnote).foregroundStyle(Theme.muted)
            }
            if crew.lines.isEmpty {
              VStack(alignment: .leading, spacing: 6) {
                Text("Ask the crew").font(.headline)
                Text("Try \"what am I missing this week?\" or \"move tonight's dinner to Thursday\".")
                  .font(.subheadline).foregroundStyle(Theme.muted)
              }
              .padding(.top, 8)
            }
            ForEach(crew.lines) { Bubble(line: $0) }
            if crew.waitingForApproval {
              VStack(alignment: .leading, spacing: 12) {
                Text("The crew wants to make a change").font(.subheadline.weight(.semibold))
                Text("Nothing changes until you answer. You can also say yes or no.")
                  .font(.footnote).foregroundStyle(Theme.muted)
                HStack(spacing: 10) {
                  Button("Yes") { crew.approve(true) }.buttonStyle(.borderedProminent).tint(Theme.green)
                  Button("No") { crew.approve(false) }.buttonStyle(.bordered)
                }
              }
              .padding(16)
              .background(.white, in: RoundedRectangle(cornerRadius: 18))
              .overlay(RoundedRectangle(cornerRadius: 18).stroke(Theme.green, lineWidth: 1.5))
            }
            if !crew.steps.isEmpty {
              VStack(alignment: .leading, spacing: 6) {
                Text("What the crew did").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                ForEach(Array(crew.steps.enumerated()), id: \.offset) { _, s in
                  Text(s).font(.footnote).foregroundStyle(Theme.ink)
                }
              }
            }
          }
          .padding(16)
        }
        HStack(spacing: 8) {
          TextField("Ask the crew", text: $typed)
            .textFieldStyle(.plain)
            .padding(.leading, 18)
            .onSubmit(send)
          Button(action: send) {
            Image(systemName: crew.busy ? "hourglass" : "arrow.up")
              .font(.headline).foregroundStyle(.white)
              .frame(width: 44, height: 44)
              .background(Theme.green, in: Circle())
          }
          .disabled(typed.isEmpty || crew.busy)
          .accessibilityLabel("Send")
        }
        .padding(4)
        .background(.white, in: Capsule())
        .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
        .padding(.horizontal, 16).padding(.bottom, 10)
      }
      .background(Theme.canvas)
      .navigationTitle("Kitchen Crew")
    }
  }

  private func send() {
    let t = typed.trimmingCharacters(in: .whitespaces)
    guard !t.isEmpty else { return }
    typed = ""
    Task { await crew.ask(t) }
  }
}

// MARK: - Shopping tab

struct ShoppingView: View {
  @EnvironmentObject var crew: CrewModel
  @EnvironmentObject var glasses: Glasses
  var openGlasses: () -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          GlassesBar(subtitle: glasses.cameraOn ? "Watching what you pick up. Frames are not saved." : "The camera turns on only during a trip", action: openGlasses)
          if crew.shopping {
            Text("Hold items up or put them in the cart. Say \"crew, check out\" at the register to hear what's left.")
              .font(.subheadline).foregroundStyle(Theme.muted)
            ForEach(crew.lines.reversed()) { Bubble(line: $0) }
            Button(role: .destructive) { Task { await crew.endShopping() } } label: {
              Text("End trip").frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.bordered).tint(Theme.warn)
          } else {
            VStack(alignment: .leading, spacing: 8) {
              Text("Shop with your list in your ear").font(.title3.weight(.semibold))
              Text("The crew builds the list from this week's meal plan minus your pantry. At the store it checks items off as you pick them up and tells you when something is already at home.")
                .font(.subheadline).foregroundStyle(Theme.muted)
            }
            Button { Task { await crew.startShopping() } } label: {
              Text("Start a shopping trip").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent).tint(Theme.green)
            Text("You can also press the capture button on the glasses.").font(.footnote).foregroundStyle(Theme.muted)
          }
        }
        .padding(16)
      }
      .background(Theme.canvas)
      .navigationTitle("Shopping")
    }
  }
}

// MARK: - Glasses tab (setup and status)

struct GlassesView: View {
  @EnvironmentObject var glasses: Glasses

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          VStack(spacing: 14) {
            Image(systemName: "eyeglasses").font(.system(size: 64, weight: .light)).foregroundStyle(.white)
            HStack(spacing: 8) {
              Circle().fill(glasses.link == .connected ? Theme.leaf : Theme.forestText).frame(width: 8, height: 8)
              Text(glasses.link.title).font(.subheadline).foregroundStyle(Theme.forestText)
            }
          }
          .frame(maxWidth: .infinity).padding(.vertical, 40)
          .background(Theme.forest, in: RoundedRectangle(cornerRadius: 22))

          if case let .failed(why) = glasses.link {
            Text(why).font(.subheadline).foregroundStyle(Theme.warn)
              .padding(14).frame(maxWidth: .infinity, alignment: .leading)
              .background(Theme.warnBg, in: RoundedRectangle(cornerRadius: 14))
          }

          VStack(alignment: .leading, spacing: 14) {
            step(1, "Turn on Developer Mode in the Meta AI app", done: glasses.registered)
            step(2, "Register Kitchen Crew with Meta AI", done: glasses.registered)
            step(3, "Glasses on, connected, microphone allowed", done: glasses.link == .connected)
          }

          if !glasses.deviceReport.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
              Text("What Meta AI reports").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
              ForEach(glasses.deviceReport, id: \.self) { Text($0).font(.footnote).foregroundStyle(Theme.ink) }
            }
          }

          VStack(spacing: 10) {
            switch glasses.link {
            case .connected:
              Button("Disconnect", role: .destructive) { glasses.disconnect() }
                .buttonStyle(.bordered).frame(maxWidth: .infinity)
            case .connecting, .registering:
              ProgressView().frame(maxWidth: .infinity)
            default:
              Button { Task { await glasses.connect() } } label: {
                Text(glasses.link == .registered ? "Connect" : "Try connecting").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 8)
              }
              .buttonStyle(.borderedProminent).tint(Theme.green)
              Button("Register with Meta AI") { Task { await glasses.register() } }
                .font(.subheadline).foregroundStyle(Theme.greenDeep)
            }
          }
        }
        .padding(16)
      }
      .background(Theme.canvas)
      .navigationTitle("Glasses")
    }
  }

  private func step(_ n: Int, _ text: String, done: Bool) -> some View {
    HStack(alignment: .top, spacing: 12) {
      ZStack {
        Circle().fill(done ? Theme.green : Theme.tint).frame(width: 26, height: 26)
        if done {
          Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(.white)
        } else {
          Text("\(n)").font(.caption.weight(.semibold)).foregroundStyle(Theme.greenDeep)
        }
      }
      Text(text).font(.subheadline).foregroundStyle(done ? Theme.muted : Theme.ink)
    }
  }
}

// MARK: - Settings tab

struct SettingsView: View {
  @EnvironmentObject var crew: CrewModel

  var body: some View {
    NavigationStack {
      Form {
        Section("Crew service") {
          TextField("https://crew.example.com", text: $crew.serverURL)
            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
          SecureField("App token", text: $crew.appToken)
        }
        Section {
          HStack {
            Text("Voice")
            Spacer()
            Text(crew.voiceName).foregroundStyle(Theme.muted)
          }
          Button("Play a test line") { Task { await crew.testVoice() } }
        } header: { Text("Voice") } footer: {
          Text("For a natural voice, download one free: iPhone Settings > Accessibility > Spoken Content > Voices > English > pick one marked Premium or Enhanced. The app uses the best one installed.")
        }
        Section("Ask mode") {
          Picker("Mode", selection: $crew.mode) {
            ForEach(CrewModel.modes, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ")) }
          }
        }
        Section {
          Text("Camera frames go to the crew service to name the item in your hand, and are not saved anywhere.")
            .font(.footnote).foregroundStyle(Theme.muted)
        }
      }
      .navigationTitle("Settings")
    }
  }
}
