import Foundation
import Security

/// The hands-free loop: hear "crew, ..." on the glasses, send it to the crew, speak the answer,
/// ask yes or no before anything changes, and during a shopping trip check groceries as they
/// come into view.
@MainActor
final class CrewModel: ObservableObject {
  struct Line: Identifiable, Codable {
    var id = UUID()
    let who: String
    let text: String
    /// When it was said (missing on chats saved before build 125).
    var at: Date? = nil
    /// Crew lines: seconds from the question to the answer.
    var took: Double? = nil
    /// Crew lines: what happened to the voice when it didn't play ("voice didn't play: ...").
    var note: String? = nil
  }
  /// One conversation. Kept on the phone (last 30 chats), newest first.
  struct Chat: Identifiable, Codable {
    var id = UUID()
    var lines: [Line] = []
    var updated = Date()
    var title: String {
      guard let first = lines.first(where: { $0.who == "You" })?.text else { return "New chat" }
      return first.count > 40 ? String(first.prefix(40)) + "…" : first
    }
  }

  @Published var mode = "general"
  @Published private(set) var chats: [Chat]
  @Published private(set) var currentChat: UUID
  /// The open chat's lines.
  var lines: [Line] { chats.first(where: { $0.id == currentChat })?.lines ?? [] }
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
    let saved = CrewModel.loadChats()
    let start = saved.isEmpty ? [Chat()] : saved
    chats = start
    currentChat = start[0].id
    glasses.onHeard = { [weak self] text in self?.heard(text) }
    glasses.onHearing = { [weak self] in self?.hearing() }
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

  // MARK: chats

  /// Starts a fresh chat (or stays on the current one if it's still empty).
  func newChat() {
    if lines.isEmpty { return }
    let c = Chat()
    chats.insert(c, at: 0)
    currentChat = c.id
    steps = []
    saveChats()
  }

  func openChat(_ id: UUID) { currentChat = id; steps = [] }

  func deleteChat(_ id: UUID) {
    chats.removeAll { $0.id == id }
    if chats.isEmpty { chats = [Chat()] }
    if !chats.contains(where: { $0.id == currentChat }) { currentChat = chats[0].id }
    saveChats()
  }

  @discardableResult
  private func add(_ who: String, _ text: String, took: Double? = nil) -> UUID? {
    guard let i = chats.firstIndex(where: { $0.id == currentChat }) else { return nil }
    let line = Line(who: who, text: text, at: Date(), took: took)
    chats[i].lines.append(line)
    if chats[i].lines.count > 200 { chats[i].lines.removeFirst(chats[i].lines.count - 200) }
    chats[i].updated = Date()
    if i != 0 { chats.insert(chats.remove(at: i), at: 0) }
    saveChats()
    return line.id
  }

  /// Adds a crew line and speaks it; if the voice fails, the line says why.
  private func addAndSay(_ text: String, took: Double? = nil) async {
    let id = add("Crew", text, took: took)
    if let problem = await say(text), let id { note(id, problem) }
  }

  private func note(_ id: UUID, _ text: String) {
    for c in chats.indices {
      if let l = chats[c].lines.firstIndex(where: { $0.id == id }) { chats[c].lines[l].note = text; saveChats(); return }
    }
  }

  private static func loadChats() -> [Chat] {
    guard let data = UserDefaults.standard.data(forKey: "chats"),
          let saved = try? JSONDecoder().decode([Chat].self, from: data) else { return [] }
    return saved
  }

  private func saveChats() {
    if let data = try? JSONEncoder().encode(Array(chats.prefix(30))) { UserDefaults.standard.set(data, forKey: "chats") }
  }

  // MARK: what the glasses hear

  /// Set by a capture-button press, and for a few seconds after each answer: the next sentence
  /// is the request, no "crew" needed, so a conversation flows like one.
  @Published private(set) var awaitingRequest = false
  private var awaitTimeout: Task<Void, Never>?

  /// Opens the no-"crew" window. The clock starts only once the glasses are listening again (the
  /// recognizer is off while the crew speaks and takes a moment to come back), and restarts
  /// whenever a sentence is in progress, so a slow or long reply isn't cut off.
  private func listenForRequest(seconds: Double) {
    awaitingRequest = true
    awaitWindow = seconds
    awaitTimeout?.cancel()
    awaitTimeout = Task { [weak self] in
      for _ in 0..<50 { // up to 10 s for the recognizer to come back
        guard let self, !Task.isCancelled else { return }
        if self.glasses.listening { break }
        try? await Task.sleep(for: .milliseconds(200))
      }
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled else { return }
      self?.awaitingRequest = false
    }
  }
  private var awaitWindow: Double = 12

  /// A sentence is in progress: keep the window open.
  private func hearing() {
    guard awaitingRequest else { return }
    listenForRequest(seconds: awaitWindow)
  }

  private func heard(_ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = t.lowercased()
    if awaitingRequest, pendingApproval == nil, !busy, !t.isEmpty {
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
    if let request = Self.afterWakeWord(t) {
      if request.lowercased().hasPrefix("start shopping") || request.lowercased().hasPrefix("i'm at the store") {
        Task { await startShopping() }
      } else if request.lowercased().hasPrefix("checkout") || request.lowercased().hasPrefix("check out") || request.lowercased().hasPrefix("done shopping") {
        Task { await endShopping() }
      } else if !request.isEmpty {
        Task { await ask(request) }
      } else if !busy {
        // Just "crew" and a pause: answer like the button does and take the next sentence.
        listenForRequest(seconds: 10)
        Task { await say("Yes?") }
      }
      return
    }
  }

  /// The request after "crew" when "crew" (or how the recognizer mishears it) is one of the first
  /// three words: "crew, what's for dinner", "hey crew ...", "okay so crew ...", "Cru what's ...".
  static func afterWakeWord(_ text: String) -> String? {
    let words = text.split(separator: " ")
    let wake: Set<String> = ["crew", "cru", "crue", "krew", "kru", "crews"]
    for (i, w) in words.prefix(3).enumerated() {
      let bare = w.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?'"))
      if wake.contains(bare) {
        return words.dropFirst(i + 1).joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?"))
      }
    }
    return nil
  }

  /// Press: the crew says "Yes?" and takes the next sentence as the request (push to talk).
  /// Works even if always-on listening has stopped, because it starts the recognizer again.
  private func button() {
    guard !busy else { return }
    glasses.reviveSpeech()
    listenForRequest(seconds: 10)
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
    let history = lines.suffix(10).map { ["who": $0.who, "text": $0.text] }
    add("You", request)
    let asked = Date()
    do {
      let id = try await client.ask(request, mode: shopping ? "shopping" : mode, history: history)
      while true {
        try await Task.sleep(for: .milliseconds(250))
        let run = try await client.run(id)
        steps = run.steps
        if run.status == "waiting", let q = run.spoken {
          await addAndSay(q, took: Date().timeIntervalSince(asked))
          let yes = await waitForYesNo()
          try await client.answer(id, yes: yes)
        } else if run.status == "done" || run.status == "failed" {
          let answer = run.answer ?? "Done."
          busy = false // free for the next question while the answer is spoken
          await addAndSay(answer, took: Date().timeIntervalSince(asked))
          glasses.reviveSpeech()
          // Follow-ups don't need "crew": the next sentence continues the conversation.
          listenForRequest(seconds: 12)
          return
        }
      }
    } catch CrewError.http(503, _) {
      add("Crew", "The crew service is running but still needs its keys.")
      await say("I'm here, but the crew still needs its keys before I can answer.")
    } catch {
      add("Crew", error.localizedDescription)
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
      await addAndSay(list)
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
        add("Crew", say)
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
      add("Crew", say)
      await self.say(say)
    }
    trip = nil
  }

  /// Lines already spoken, kept for this session so a repeat ("Yes?", "Crew's here.") is instant and free.
  private var voiceCache: [String: Data] = [:]

  /// Only the natural ElevenLabs voice from the crew service. If it can't be reached, a short tone
  /// plays and the words stay on screen: the phone's robotic voice is never used.
  /// Returns nil when the voice played, otherwise why it didn't (shown under the line).
  @discardableResult
  private func say(_ text: String) async -> String? {
    if let audio = voiceCache[text], await speaker.play(audio) { return nil }
    guard let client else { speaker.chime(); return "voice didn't play: crew not set up" }
    let audio: Data
    do { audio = try await client.speak(text) } catch {
      speaker.chime()
      return "voice didn't play: \(error.localizedDescription)"
    }
    guard await speaker.play(audio) else { speaker.chime(); return "voice didn't play: the phone couldn't play the audio (\(audio.count) bytes)" }
    if text.count <= 80 { voiceCache[text] = audio }
    return nil
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
