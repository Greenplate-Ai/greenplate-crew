import SwiftUI

// MARK: - Theme (GreenplateAi tokens, see ios/DESIGN.md)

// Light values, then the brand's dark values (greenplateai-v2 tokens, [data-theme="dark"]).
enum Theme {
  static let green = Color(hex: 0x25A777)
  static let greenDeep = Color(light: 0x186F50, dark: 0x3CC48F)
  static let forest = Color(hex: 0x0E2B1F)
  static let leaf = Color(hex: 0x4ECB37)
  static let tint = Color(light: 0xD9F2E7, dark: 0x12362A)
  static let tint50 = Color(light: 0xF3FAF6, dark: 0x0F2C22)
  static let ink = Color(light: 0x202428, dark: 0xFBFAF9)
  static let muted = Color(light: 0x585E6A, dark: 0xA8ADB8)
  static let line = Color(light: 0xE2DFDA, dark: 0x2B2F36)
  static let canvas = Color(light: 0xFBFAF9, dark: 0x0E1013)
  static let surface = Color(light: 0xFFFFFF, dark: 0x171A1F)
  static let bubbleInk = Color(light: 0x14402F, dark: 0xD9F2E7)
  static let forestText = Color(hex: 0xB9D6C6)
  static let warn = Color(light: 0x8A3B2E, dark: 0xE8A898)
  static let warnBg = Color(light: 0xFCF7F6, dark: 0x2A1A17)
}

extension Color {
  init(hex: UInt32) { self.init(UIColor(hex: hex)) }
  /// Follows the app's appearance (Settings > Appearance).
  init(light: UInt32, dark: UInt32) {
    self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
  }
}

extension UIColor {
  convenience init(hex: UInt32) {
    self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
  }
}

/// Settings > Appearance. Light unless changed; set on the whole window so titles, text fields
/// and the tab bar all follow it (preferredColorScheme alone left titles in dark-mode colors).
enum Appearance: String, CaseIterable, Identifiable {
  case light, dark, system
  var id: String { rawValue }
  var label: String {
    switch self { case .light: "Light"; case .dark: "Dark"; case .system: "Match phone" }
  }
  static func apply(_ raw: String) {
    let style: UIUserInterfaceStyle = switch Appearance(rawValue: raw) ?? .light {
    case .light: .light
    case .dark: .dark
    case .system: .unspecified
    }
    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
      scene.windows.forEach { $0.overrideUserInterfaceStyle = style }
    }
  }
}

// MARK: - Root: four tabs

struct ContentView: View {
  @EnvironmentObject var glasses: Glasses
  @State private var tab = 0
  @AppStorage("appearance") private var appearance = Appearance.light.rawValue

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
    .onAppear { Appearance.apply(appearance); if !glasses.registered { tab = 2 } }
    .onChange(of: appearance) { _, new in Appearance.apply(new) }
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
  /// "12:43:20 AM · answered in 17s"
  private var caption: String? {
    guard let at = line.at else { return nil }
    let time = at.formatted(date: .omitted, time: .standard)
    guard let took = line.took else { return time }
    return "\(time) · answered in \(Int(took.rounded()))s"
  }
  var body: some View {
    let mine = line.who == "You"
    HStack {
      if mine { Spacer(minLength: 48) }
      VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
        Text(line.text)
          .font(.body)
          .foregroundStyle(mine ? Theme.bubbleInk : Theme.ink)
          .padding(.horizontal, 14).padding(.vertical, 11)
          .background(mine ? Theme.tint : Theme.surface, in: RoundedRectangle(cornerRadius: 18))
          .overlay(RoundedRectangle(cornerRadius: 18).stroke(mine ? .clear : Theme.line, lineWidth: 1))
        if let caption {
          Text(caption).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 6)
        }
        if let note = line.note {
          Text(note).font(.caption).foregroundStyle(.red).padding(.horizontal, 6)
        }
      }
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
  @State private var showChats = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        // Pinned above the chat, so messages scroll beneath it instead of sliding it under the title.
        VStack(alignment: .leading, spacing: 8) {
          GlassesBar(subtitle: glasses.link != .connected ? "Tap to set up your glasses" : (crew.awaitingRequest ? "Go ahead, I'm listening" : glasses.listening ? "Listening. Say \"Hey Crew, ...\"" : "Not listening right now. Restarting..."), action: openGlasses)
          if !glasses.heard.isEmpty {
            Text("Heard: \(glasses.heard)").font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
          }
          if crew.kitchenMode {
            HStack {
              Text(crew.pulledOut.isEmpty ? "Kitchen mode: show a barcode" : "Out: \(crew.pulledOut.joined(separator: ", "))")
                .font(.footnote).lineLimit(2)
              Spacer()
              Button("Done") { Task { await crew.endKitchen() } }.font(.footnote).buttonStyle(.bordered)
            }
          }
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
        ScrollViewReader { scroller in
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
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
              .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18))
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
            Color.clear.frame(height: 1).id("bottom")
          }
          .padding(16)
        }
        // Follow the conversation: jump to the newest message as it arrives, and when a chat opens.
        .onAppear { scroller.scrollTo("bottom", anchor: .bottom) }
        .onChange(of: crew.lines.count) { withAnimation(.easeOut(duration: 0.25)) { scroller.scrollTo("bottom", anchor: .bottom) } }
        .onChange(of: crew.currentChat) { scroller.scrollTo("bottom", anchor: .bottom) }
        .onChange(of: crew.waitingForApproval) { withAnimation { scroller.scrollTo("bottom", anchor: .bottom) } }
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
        .background(Theme.surface, in: Capsule())
        .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
        .padding(.horizontal, 16).padding(.bottom, 10)
      }
      .background(Theme.canvas)
      .navigationTitle("Kitchen Crew")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button { showChats = true } label: { Image(systemName: "list.bullet") }
            .accessibilityLabel("Chats")
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button { crew.newChat() } label: { Image(systemName: "square.and.pencil") }
            .accessibilityLabel("New chat")
        }
      }
      .sheet(isPresented: $showChats) { ChatsList(close: { showChats = false }) }
    }
  }

  private func send() {
    let t = typed.trimmingCharacters(in: .whitespaces)
    guard !t.isEmpty else { return }
    typed = ""
    Task { await crew.ask(t) }
  }
}

/// Past chats, newest first. Tap to open, swipe to delete.
struct ChatsList: View {
  @EnvironmentObject var crew: CrewModel
  var close: () -> Void

  var body: some View {
    NavigationStack {
      List {
        ForEach(crew.chats) { chat in
          Button {
            crew.openChat(chat.id)
            close()
          } label: {
            VStack(alignment: .leading, spacing: 3) {
              Text(chat.title).foregroundStyle(Theme.ink).lineLimit(1)
              Text(chat.updated, format: .relative(presentation: .named))
                .font(.footnote).foregroundStyle(Theme.muted)
            }
          }
          .listRowBackground(chat.id == crew.currentChat ? Theme.tint50 : Theme.surface)
        }
        .onDelete { idx in idx.map { crew.chats[$0].id }.forEach(crew.deleteChat) }
      }
      .navigationTitle("Chats")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Done", action: close) }
        ToolbarItem(placement: .topBarLeading) {
          Button { crew.newChat(); close() } label: { Image(systemName: "square.and.pencil") }
            .accessibilityLabel("New chat")
        }
      }
    }
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
            Text("Hold items up or put them in the cart. Say \"Hey Crew, check out\" at the register to hear what's left.")
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
            Text("You can also press and hold the capture button on the glasses.").font(.footnote).foregroundStyle(Theme.muted)
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
              Button { Task { await glasses.setUp() } } label: {
                Text(glasses.registered ? "Connect glasses" : "Set up my glasses").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 8)
              }
              .buttonStyle(.borderedProminent).tint(Theme.green)
              Text(glasses.registered ? "Put your glasses on. Kitchen Crew connects by itself when you open it." : "Meta AI opens for a moment to approve Kitchen Crew, then you're back here and connected.")
                .font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
              Button("Register again with Meta AI") { Task { await glasses.register() } }
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
  @AppStorage("appearance") private var appearance = Appearance.light.rawValue

  var body: some View {
    NavigationStack {
      Form {
        Section {
          HStack {
            Text("Voice")
            Spacer()
            Text(crew.voiceName).foregroundStyle(Theme.muted)
          }
          Button("Play a test line") { Task { await crew.testVoice() } }
        } header: { Text("Voice") }
        Section {
          Picker("Appearance", selection: $appearance) {
            ForEach(Appearance.allCases) { Text($0.label).tag($0.rawValue) }
          }
          .pickerStyle(.segmented)
        } header: { Text("Appearance") }
        Section {
          Text("Camera frames go to the crew to name the item in your hand, and are not saved anywhere.")
            .font(.footnote).foregroundStyle(Theme.muted)
        } header: { Text("Privacy") }
        Section {
          NavigationLink("Developer") { DeveloperView() }
        } footer: { Text(BuildInfo.short) }
      }
      .navigationTitle("Settings")
    }
  }
}

/// Which build is on the phone. CI writes CrewBuildCommit and CrewBuildDate into Info.plist;
/// version and build number are Xcode's (the build number is the TestFlight build).
enum BuildInfo {
  private static func info(_ key: String) -> String { Bundle.main.object(forInfoDictionaryKey: key) as? String ?? "" }
  static var version: String { info("CFBundleShortVersionString") }
  static var build: String { info("CFBundleVersion") }
  static var commit: String { let c = info("CrewBuildCommit"); return c.isEmpty ? "local" : c }
  static var date: String { let d = info("CrewBuildDate"); return d.isEmpty ? "-" : d }
  static var short: String { "Version \(version) (build \(build)) · \(commit)" }
}

struct DeveloperView: View {
  @EnvironmentObject var crew: CrewModel
  @State private var health = ""

  var body: some View {
    Form {
      Section {
        row("Version", BuildInfo.version)
        row("Build", BuildInfo.build)
        row("Commit", BuildInfo.commit)
        row("Built", BuildInfo.date)
      } header: { Text("This build") }
      Section {
        row("Address", crew.serviceAddress.isEmpty ? "not set" : crew.serviceAddress)
        Button("Check connection") { Task { health = await crew.checkService() } }
        if !health.isEmpty { Text(health).font(.footnote).foregroundStyle(Theme.muted).textSelection(.enabled) }
      } header: { Text("Crew service") }
      Section {
        TextField("Crew service address (blank = built in)", text: $crew.serverURL)
          .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
        SecureField("App token (blank = built in)", text: $crew.appToken)
      } header: { Text("Override") } footer: { Text("Leave both blank to use what's built into this build.") }
    }
    .navigationTitle("Developer")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack {
      Text(label)
      Spacer()
      Text(value).foregroundStyle(Theme.muted).textSelection(.enabled)
    }
  }
}
