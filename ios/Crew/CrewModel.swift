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
  @Published var serverURL: String = UserDefaults.standard.string(forKey: "serverURL") ?? "" {
    didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
  }
  @Published var appToken: String = Keychain.read("appToken") ?? "" {
    didSet { Keychain.write("appToken", appToken) }
  }

  let glasses = Glasses()
  private let speaker = Speaker()
  var voiceName: String { speaker.voiceName }
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
    glasses.onLaunched = { [weak self] in Task { await self?.glasses.connect(); await self?.say("Crew's here.") } }
  }

  private var client: CrewClient? {
    guard let url = URL(string: serverURL), !appToken.isEmpty else { return nil }
    return CrewClient(baseURL: url, token: appToken)
  }

  // MARK: what the glasses hear

  private func heard(_ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = t.lowercased()
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

  /// The capture button starts or ends a shopping trip.
  private func button() {
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

  /// The natural ElevenLabs voice from the crew service when it's reachable, the phone's voice otherwise.
  private func say(_ text: String) async {
    if let client, let audio = try? await client.speak(text), await speaker.play(audio) { return }
    await speaker.say(text)
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
