import Foundation
import Security

/// The hands-free loop: hear "crew, ..." on the glasses, send it to the crew, speak the answer,
/// ask yes or no before anything changes, and during a shopping trip check groceries as they
/// come into view.
@MainActor
final class CrewModel: ObservableObject {
  struct Line: Identifiable { let id = UUID(); let who: String; let text: String }

  @Published var mode = "general"
  @Published private(set) var lines: [Line] = []
  @Published private(set) var steps: [String] = []
  @Published private(set) var busy = false
  @Published private(set) var shopping = false
  /// Developer override; empty means the address built into the app (Info.plist CrewServiceURL).
  @Published var serverURL: String = UserDefaults.standard.string(forKey: "serverURL") ?? "" {
    didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
  }
  @Published var appToken: String = Keychain.read("appToken") ?? "" {
    didSet { Keychain.write("appToken", appToken) }
  }

  let glasses = Glasses()
  private let speaker = Speaker()
  var voiceName: String { "Crew voice (ElevenLabs)" }
  func testVoice() async { await say("Hi, this is your kitchen crew. Ready when you are.") }
  @Published private(set) var waitingForApproval = false
  private var pendingApproval: ((Bool) -> Void)? {
    didSet { waitingForApproval = pendingApproval != nil }
  }
  private var trip: String?
  private var frameTask: Task<Void, Never>?

  static let modes = ["general", "shopping", "capture", "cooking", "eating_out", "pantry_check"]

  init() {
    glasses.onHeard = { [weak self] text in self?.heard(text) }
    glasses.onButton = { [weak self] in self?.button() }
    glasses.onLongPress = { [weak self] in self?.longPress() }
    glasses.onLaunched = { [weak self] in Task { await self?.glasses.connect(); await self?.say("Crew's here.") } }
  }

  /// The crew service address in use: the developer override, else the one built into the app.
  var serviceAddress: String {
    serverURL.isEmpty ? (Bundle.main.object(forInfoDictionaryKey: "CrewServiceURL") as? String ?? "") : serverURL
  }

  /// For Settings > Developer: the service's /health reply (no token needed), or why it can't be reached.
  func checkService() async -> String {
    guard let url = URL(string: serviceAddress)?.appendingPathComponent("health") else { return "No address set." }
    do {
      let (data, _) = try await URLSession.shared.data(from: url)
      return String(decoding: data, as: UTF8.self)
    } catch { return "Can't reach it: \(error.localizedDescription)" }
  }

  private var client: CrewClient? {
    let builtInToken = Bundle.main.object(forInfoDictionaryKey: "CrewAppToken") as? String ?? ""
    let address = serviceAddress
    let token = appToken.isEmpty ? builtInToken : appToken
    guard !address.isEmpty, let url = URL(string: address), !token.isEmpty else { return nil }
    return CrewClient(baseURL: url, token: token)
  }

  // MARK: what the glasses hear

  /// Set by a capture-button press: the next sentence is the request, no "crew" needed.
  private var awaitingRequest = false
  private var awaitTimeout: Task<Void, Never>?

  private func heard(_ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = t.lowercased()
    if awaitingRequest, pendingApproval == nil, !t.isEmpty {
      awaitingRequest = false
      awaitTimeout?.cancel()
      let request = lower.hasPrefix("crew") ? String(t.dropFirst(4)).trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?")) : t
      Task { await ask(request) }
      return
    }
    if let decide = pendingApproval {
      if lower.hasPrefix("yes") || lower.hasPrefix("yeah") || lower.hasPrefix("do it") { pendingApproval = nil; decide(true) }
      else if lower.hasPrefix("no") || lower.hasPrefix("don't") || lower.hasPrefix("stop") { pendingApproval = nil; decide(false) }
      return
    }
    for wake in ["hey crew", "okay crew", "ok crew", "crew"] where lower.hasPrefix(wake) {
      let request = String(t.dropFirst(wake.count)).trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?"))
      if request.lowercased().hasPrefix("start shopping") || request.lowercased().hasPrefix("i'm at the store") {
        Task { await startShopping() }
      } else if request.lowercased().hasPrefix("checkout") || request.lowercased().hasPrefix("check out") || request.lowercased().hasPrefix("done shopping") {
        Task { await endShopping() }
      } else if !request.isEmpty {
        Task { await ask(request) }
      }
      return
    }
  }

  /// Press: the crew says "Yes?" and takes the next sentence as the request (push to talk).
  /// Works even if always-on listening has stopped, because it starts the recognizer again.
  private func button() {
    guard !busy else { return }
    glasses.reviveSpeech()
    awaitingRequest = true
    awaitTimeout?.cancel()
    awaitTimeout = Task { [weak self] in
      try? await Task.sleep(for: .seconds(10))
      self?.awaitingRequest = false
    }
    Task { await say("Yes?") }
  }

  /// Press and hold: start or end a shopping trip.
  private func longPress() {
    Task { shopping ? await endShopping() : await startShopping() }
  }

  // MARK: asking the crew

  func ask(_ request: String) async {
    guard let client else { return await say(CrewError.notSetUp.localizedDescription) }
    guard !busy else { return await say("Still on the last one.") }
    busy = true
    defer { busy = false }
    lines.append(Line(who: "You", text: request))
    do {
      let id = try await client.ask(request, mode: shopping ? "shopping" : mode)
      while true {
        try await Task.sleep(for: .milliseconds(600))
        let run = try await client.run(id)
        steps = run.steps
        if run.status == "waiting", let q = run.spoken {
          lines.append(Line(who: "Crew", text: q))
          await say(q)
          let yes = await waitForYesNo()
          try await client.answer(id, yes: yes)
        } else if run.status == "done" || run.status == "failed" {
          let answer = run.answer ?? "Done."
          lines.append(Line(who: "Crew", text: answer))
          await say(answer)
          return
        }
      }
    } catch CrewError.http(503, _) {
      lines.append(Line(who: "Crew", text: "The crew service is running but still needs its keys."))
      await say("I'm here, but the crew still needs its keys before I can answer.")
    } catch {
      lines.append(Line(who: "Crew", text: error.localizedDescription))
      await say("I couldn't reach the crew.")
    }
  }

  private func waitForYesNo() async -> Bool {
    await withCheckedContinuation { c in
      var done = false
      pendingApproval = { yes in if !done { done = true; c.resume(returning: yes) } }
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(20))
        if let p = self?.pendingApproval { self?.pendingApproval = nil; p(false) }
      }
    }
  }

  /// Phone-screen buttons answer approvals too.
  func approve(_ yes: Bool) {
    if let p = pendingApproval { pendingApproval = nil; p(yes) }
  }

  // MARK: live shopping

  func startShopping() async {
    guard let client else { return await say(CrewError.notSetUp.localizedDescription) }
    guard !shopping else { return }
    do {
      let today = Self.day(0), week = Self.day(6)
      let t = try await client.startShopping(from: today, to: week)
      trip = t.tripId
      shopping = true
      await glasses.startCamera()
      let list = t.needs.isEmpty ? "Nothing on the list this week." : "\(t.needs.count) things on the list. First up: \(t.needs.prefix(3).joined(separator: ", "))."
      lines.append(Line(who: "Crew", text: list))
      await say("Shopping mode. \(list)")
      frameTask = Task { [weak self] in await self?.watchFrames() }
    } catch {
      await say("I couldn't build the list.")
    }
  }

  private func watchFrames() async {
    while shopping, !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(1500))
      guard let client, let trip, !busy, let jpeg = glasses.takeFrame() else { continue }
      if let said = try? await client.frame(trip: trip, jpeg: jpeg), let say = said.say {
        lines.append(Line(who: "Crew", text: say))
        await self.say(say)
      }
    }
  }

  func endShopping() async {
    guard shopping else { return }
    shopping = false
    frameTask?.cancel()
    glasses.stopCamera()
    if let client, let trip, let say = try? await client.checkout(trip: trip) {
      lines.append(Line(who: "Crew", text: say))
      await self.say(say)
    }
    trip = nil
  }

  /// Lines already spoken, kept for this session so a repeat ("Yes?", "Crew's here.") is instant and free.
  private var voiceCache: [String: Data] = [:]

  /// Only the natural ElevenLabs voice from the crew service. If it can't be reached, a short tone
  /// plays and the words stay on screen: the phone's robotic voice is never used.
  private func say(_ text: String) async {
    if let audio = voiceCache[text], await speaker.play(audio) { return }
    if let client, let audio = try? await client.speak(text), await speaker.play(audio) {
      if text.count <= 80 { voiceCache[text] = audio }
      return
    }
    speaker.chime()
  }

  private static func day(_ offset: Int) -> String {
    let d = Calendar.current.date(byAdding: .day, value: offset, to: Date()) ?? Date()
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: d)
  }
}

/// The app token lives in the Keychain, not in settings files.
enum Keychain {
  static func read(_ key: String) -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key, kSecReturnData as String: true]
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }

  static func write(_ key: String, _ value: String) {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: key]
    SecItemDelete(q as CFDictionary)
    guard !value.isEmpty else { return }
    var add = q
    add[kSecValueData as String] = Data(value.utf8)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(add as CFDictionary, nil)
  }
}
