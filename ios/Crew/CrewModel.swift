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
  /// nil until checked; false shows "Connect your kitchen".
  @Published private(set) var kitchenConnected: Bool?
  @Published private(set) var connectingKitchen = false
  private let signIn = KitchenSignIn()
  @Published private(set) var kitchenMode = false
  @Published private(set) var pulledOut: [String] = []
  private var kitchenSession: String?
  private var kitchenTask: Task<Void, Never>?

  static let modes = ["general", "shopping", "capture", "cooking", "eating_out", "pantry_check"]

  init() {
    var saved = CrewModel.loadChats()
    // A new build starts a new chat; the old ones stay in the chats list.
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    if UserDefaults.standard.string(forKey: "lastBuild") != build {
      UserDefaults.standard.set(build, forKey: "lastBuild")
      if let first = saved.first, !first.lines.isEmpty { saved.insert(Chat(), at: 0) }
    }
    let start = saved.isEmpty ? [Chat()] : saved
    chats = start
    currentChat = start[0].id
    glasses.onHeard = { [weak self] text in self?.heard(text) }
    glasses.onHearing = { [weak self] in self?.hearing() }
    glasses.onButton = { [weak self] in self?.button() }
    glasses.onEvent = { [weak self] kind, detail in self?.client?.event(kind, detail: detail) }
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
    if let problem = await say(text) {
      if let id { note(id, problem) }
      client?.event("voice_failed", detail: problem)
    }
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
  private func listenForRequest(seconds: Double, chime: Bool = true) {
    awaitingRequest = true
    awaitWindow = seconds
    awaitTimeout?.cancel()
    awaitTimeout = Task { [weak self] in
      for _ in 0..<50 { // up to 10 s for the recognizer to come back
        guard let self, !Task.isCancelled else { return }
        if self.glasses.listening { break }
        try? await Task.sleep(for: .milliseconds(200))
      }
      // The tone says "go ahead": it plays once the glasses can actually hear you.
      if chime, !Task.isCancelled { self?.speaker.listeningChime() }
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled, let self else { return }
      self.awaitingRequest = false
      if self.bareWake { self.countFalseWake("no request after Yes?") }
    }
  }
  private var awaitWindow: Double = 12

  /// A sentence is in progress: keep the window open.
  private func hearing() {
    // Still talking after a sentence ended: hold the request until you stop.
    if !sentence.isEmpty { sendWhenQuiet(after: 3.5); return }
    guard awaitingRequest else { return }
    listenForRequest(seconds: awaitWindow, chime: false)
  }

  // MARK: done talking: a pause isn't the end of the request

  /// The request so far, while waiting to hear whether more is coming.
  private var sentence = ""
  private var finishing: Task<Void, Never>?

  /// A sentence ended. Wait a moment: if you keep talking, the next sentence joins it
  /// ("add milk... and eggs"). Then send the whole thing.
  private func askWhenDone(_ text: String) {
    sentence = sentence.isEmpty ? text : "\(sentence) \(text)"
    sendWhenQuiet(after: 0.8)
  }

  private func sendWhenQuiet(after seconds: Double) {
    finishing?.cancel()
    finishing = Task { [weak self] in
      try? await Task.sleep(for: .seconds(seconds))
      guard let self, !Task.isCancelled else { return }
      let request = self.sentence
      self.sentence = ""
      self.finishing = nil
      if !request.isEmpty { await self.ask(request) }
    }
  }

  private var lastGreeting: Date?
  private var finalsHeard = 0

  // MARK: wake tracking (Settings > Developer, and wake_* lines in the service log)

  /// Every wake, kept on the phone across launches, and how many looked false: a bare wake that
  /// got no request before the window closed, or "never mind" / "not you" straight after one.
  @Published private(set) var wakes = UserDefaults.standard.integer(forKey: "wakes")
  @Published private(set) var falseWakes = UserDefaults.standard.integer(forKey: "falseWakes")
  /// A bare wake ("Yes?") still waiting to see whether a request follows.
  private var bareWake = false
  /// A wake within the last 20 s, so "never mind" / "not you" can mark it false.
  private var lastWakeAt: Date?

  private func countWake(_ heard: String, bare: Bool) {
    wakes += 1
    UserDefaults.standard.set(wakes, forKey: "wakes")
    lastWakeAt = Date()
    bareWake = bare
    client?.event("woke", detail: "\(bare ? "bare" : "with request"): \(heard.lowercased().prefix(60))")
  }

  private func countFalseWake(_ why: String) {
    falseWakes += 1
    UserDefaults.standard.set(falseWakes, forKey: "falseWakes")
    lastWakeAt = nil
    bareWake = false
    client?.event("wake_false", detail: why)
  }

  func resetWakeCounts() {
    wakes = 0; falseWakes = 0
    UserDefaults.standard.set(0, forKey: "wakes")
    UserDefaults.standard.set(0, forKey: "falseWakes")
  }

  /// A spoken answer to "Yes or no?", with or without "Hey Crew" in front; nil if it's neither.
  static func yesOrNo(_ said: String) -> Bool? {
    let raw = afterWakeWord(said).flatMap { $0.isEmpty ? nil : $0 } ?? said
    let r = raw.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?"))
    let starts = { (words: [String]) in words.contains { r == $0 || r.hasPrefix($0 + " ") || r.hasPrefix($0 + ",") || r.hasPrefix($0 + ".") } }
    // "No" first: "no, don't" and "no thanks" are noes.
    if starts(["no", "nope", "nah", "don't", "do not", "stop", "cancel", "never mind", "not now", "wait", "hold on"]) { return false }
    if starts(["yes", "yeah", "yep", "yup", "sure", "do it", "go ahead", "okay", "ok", "please", "correct", "sounds good", "that's right", "absolutely", "of course", "add it", "add them"]) { return true }
    return nil
  }

  static func notYou(_ r: String) -> Bool {
    let r = r.lowercased()
    return r.contains("not you") || r.contains("not talking to you") || r.contains("false alarm")
  }

  static func callsOff(_ r: String) -> Bool {
    let r = r.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?"))
    return ["never mind", "nevermind", "not you", "not talking to you", "wasn't talking to you", "false alarm",
            "nothing", "cancel", "forget it", "no one", "nobody"].contains { r == $0 || r.hasPrefix($0 + " ") || r.hasPrefix($0 + ",") }
  }

  private func heard(_ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    finalsHeard += 1
    if finalsHeard % 10 == 1 { client?.event("finals_heard", detail: "\(finalsHeard)") } // proof the recognizer is delivering
    let lower = t.lowercased()
    // The same request, continued after a pause.
    if !sentence.isEmpty, !t.isEmpty { askWhenDone(t); return }
    if awaitingRequest, pendingApproval == nil, !busy, !t.isEmpty {
      awaitingRequest = false
      awaitTimeout?.cancel()
      // In the follow-up window no wake phrase is needed; drop one if it was said anyway.
      let request = Self.afterWakeWord(t)
        ?? (lower.hasPrefix("crew") ? String(t.dropFirst(4)).trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?")) : t)
      // After a bare wake any "never mind" means it woke by mistake; after an answer only
      // "not you" / "false alarm" does ("never mind" there is just changing your mind).
      if let woke = lastWakeAt, Date().timeIntervalSince(woke) < 20,
         bareWake ? Self.callsOff(request) : Self.notYou(request) {
        countFalseWake("called off: \(request.lowercased().prefix(30))")
        Task { await say("Okay.") }
        return
      }
      bareWake = false
      if request.isEmpty {
        listenForRequest(seconds: 10)
        Task { await say("Yes?") }
        return
      }
      if Self.wantsMealPhoto(request) { Task { await ask(request) } } else { askWhenDone(request) }
      return
    }
    if let decide = pendingApproval {
      if let yes = Self.yesOrNo(t) { pendingApproval = nil; decide(yes) }
      return
    }
    // The recognizer sometimes ends a sentence after "Hey": join it to the next one if it comes quickly.
    let joinedText: String
    if let greet = lastGreeting, Date().timeIntervalSince(greet) < 4 { joinedText = "hey " + t } else { joinedText = t }
    lastGreeting = nil
    let words = lower.split(separator: " ").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?'-")) }
    if words.count == 1, ["hey", "hi", "hello", "okay", "ok", "yo"].contains(words[0]) { lastGreeting = Date(); return }
    // Short lines starting with a greeting are wake attempts: log what was heard so misses can be fixed.
    if words.count <= 6, let w = words.first, ["hey", "hi", "hello", "okay", "ok", "yo", "hay", "a", "eh"].contains(w) {
      client?.event("wake_heard", detail: String(lower.prefix(60)))
    }
    guard let request = Self.afterWakeWord(joinedText) else {
      // Heard something crew-like that didn't wake it: logged (word count only) so misses show up.
      if words.contains(where: { Self.crewWords.contains($0) && $0 != "true" }) {
        client?.event("wake_missed", detail: "\(words.count) words")
      }
      return
    }
    countWake(joinedText, bare: request.isEmpty)
    if Self.callsOff(request) { countFalseWake("called off: \(request.lowercased().prefix(30))"); return }
    do {
      let r = request.lowercased()
      if Self.wantsKitchenMode(r) { Task { await startKitchen() }; return }
      if kitchenMode, Self.endsKitchenMode(r) { Task { await endKitchen() }; return }
      if kitchenMode, Self.wantsKitchenPhoto(r) { Task { await kitchenPhoto() }; return }
      if Self.wantsMealPhoto(request) {
        Task { await logMealFromPhoto() }
      } else if request.lowercased().hasPrefix("start shopping") || request.lowercased().hasPrefix("i'm at the store") {
        Task { await startShopping() }
      } else if request.lowercased().hasPrefix("checkout") || request.lowercased().hasPrefix("check out") || request.lowercased().hasPrefix("done shopping") {
        Task { await endShopping() }
      } else if !request.isEmpty {
        askWhenDone(request)
      } else if !busy {
        // Just "crew" and a pause: answer like the button does and take the next sentence.
        listenForRequest(seconds: 10)
        Task { await say("Yes?") }
      } else {
        bareWake = false // bare wake while busy: nothing waits on it
      }
    }
  }

  /// The request around the two-word wake phrase - a greeting then "crew" ("hey crew", "hi crew",
  /// "okay crew", and how the recognizer mishears them).
  /// "Crew" alone wakes it only as the first word; mid-sentence ("the crew was great") it doesn't.
  /// "crew" and how the glasses' recognizer mishears it.
  static let crewWords: Set<String> = ["crew", "cru", "crue", "krew", "kru", "crews", "true", "cruz", "crewe", "grew", "crow"]

  static func afterWakeWord(_ text: String) -> String? {
    let words = text.split(separator: " ")
    let bare = words.map { $0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?'-")) }
    let greet: Set<String> = ["hey", "hi", "hello", "okay", "ok", "yo", "hay", "hei", "high", "eh"]
    let crew = Self.crewWords
    let joined: Set<String> = ["heycrew", "hicrew", "heycru", "hicru", "okcrew"]
    let rest = { (i: Int) in
      words.dropFirst(i).joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?"))
    }
    // Anywhere in the sentence: people say it first ("Hey Crew, what's...") or last ("what's in
    // my week? Hey Crew"), and the recognizer often joins a repeat into one line. The request is
    // what follows the phrase, or what came before it when nothing follows.
    let before = { (i: Int) in
      words.prefix(i).joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: " ,.!?"))
    }
    // "Crew, ..." as the very first word still works on its own, like before "Hey Crew".
    if let first = bare.first, crew.contains(first), first != "true", first != "grew" { return rest(1) }
    for i in 0..<bare.count {
      var after: Int?
      if joined.contains(bare[i]) { after = i + 1 }
      else if i + 1 < bare.count, greet.contains(bare[i]), crew.contains(bare[i + 1]) { after = i + 2 }
      guard let after else { continue }
      let next = rest(after)
      return next.isEmpty ? before(i) : next
    }
    return nil
  }

  static func wantsKitchenMode(_ r: String) -> Bool {
    r.hasPrefix("kitchen mode") || r.hasPrefix("start kitchen") || r.hasPrefix("i'm cooking") || r.hasPrefix("start cooking")
      || r.contains("track what i pull out") || r.contains("track what i take out")
  }
  static func endsKitchenMode(_ r: String) -> Bool {
    r.hasPrefix("done") || r.hasPrefix("stop") || r.hasPrefix("end kitchen") || r.hasPrefix("that's everything") || r.hasPrefix("that's it")
  }
  static func wantsKitchenPhoto(_ r: String) -> Bool {
    r.contains("got this") || r.contains("what's this") || r.contains("what is this") || r.contains("pulled out") || r.contains("took out") || r.contains("add this")
  }

  /// "take a picture and log what I'm eating", "log my meal", "log this"...
  static func wantsMealPhoto(_ request: String) -> Bool {
    let r = request.lowercased()
    return r.contains("log what i'm eating") || r.contains("log what i am eating") || r.contains("log my meal")
      || r.contains("log this") || r.contains("log my food") || (r.contains("picture") && r.contains("log"))
  }

  /// Photo → what's on the plate → "log that as dinner?" → logs only on a yes. The camera is on
  /// only for the moment it takes, and the photo isn't kept.
  func logMealFromPhoto() async {
    guard let client else { await say(CrewError.notSetUp.localizedDescription); return }
    guard !busy else { await say("Still on the last one."); return }
    busy = true
    defer { busy = false }
    add("You", "Log what I'm eating")
    let wasOn = glasses.cameraOn
    await glasses.startCamera()
    var jpeg: Data?
    for _ in 0..<20 where jpeg == nil { // up to 4 s for a frame
      try? await Task.sleep(for: .milliseconds(200))
      jpeg = glasses.takeFrame()
    }
    if !wasOn { glasses.stopCamera() }
    guard let jpeg else { await addAndSay("I couldn't get a picture from the glasses."); return }
    do {
      let seen = try await client.mealPhoto(jpeg: jpeg, date: Self.day(0), slot: Self.mealSlot())
      await addAndSay(seen.say)
      guard let id = seen.mealId else { return }
      let yes = await waitForYesNo()
      let done = try await client.logMeal(id, yes: yes)
      await addAndSay(done.say)
    } catch {
      add("Crew", error.localizedDescription)
      await say("I couldn't reach the crew.")
    }
    glasses.reviveSpeech()
  }

  /// The meal by the phone's clock.
  static func mealSlot(_ now: Date = Date()) -> String {
    let h = Calendar.current.component(.hour, from: now)
    switch h {
    case 5..<11: return "breakfast"
    case 11..<15: return "lunch"
    case 17..<22: return "dinner"
    default: return "snack"
    }
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
    if Self.wantsMealPhoto(request) { await logMealFromPhoto(); return } // typed, follow-up or spoken
    guard let client else { await say(CrewError.notSetUp.localizedDescription); return }
    guard !busy else { await say("Still on the last one."); return }
    busy = true
    defer { busy = false }
    let history = lines.suffix(10).map { ["who": $0.who, "text": $0.text] }
    add("You", request)
    let asked = Date()
    do {
      let id = try await client.ask(request, mode: shopping ? "shopping" : mode, history: history)
      var saidOneSec = false
      while true {
        try await Task.sleep(for: .milliseconds(400))
        // Kitchen answers take several seconds: say so instead of leaving silence.
        if !saidOneSec, Date().timeIntervalSince(asked) > 2.5 {
          saidOneSec = true
          Task { await say("One sec, checking your kitchen.") }
        }
        let run = try await client.run(id)
        steps = run.steps
        if run.status == "waiting", let q = run.spoken {
          await addAndSay(q, took: Date().timeIntervalSince(asked))
          let yes = await waitForYesNo()
          try await client.answer(id, yes: yes)
        } else if run.status == "done" || run.status == "failed" {
          let answer = run.answer ?? "Done."
          busy = false // free for the next question while the answer is spoken
          let ready = Date().timeIntervalSince(asked)
          await addAndSay(answer, took: ready)
          // From the end of your sentence to Crew finishing its answer out loud.
          client.event("answer_ready", ms: ready * 1000, detail: run.lane)
          client.event("answer_spoken", ms: Date().timeIntervalSince(asked) * 1000)
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

  // MARK: connecting the kitchen (sign-in on the phone; the service keeps it)

  func checkKitchen() async {
    guard let client, let h = try? await client.health() else { return }
    kitchenConnected = h.kitchen ?? h.crew ?? false
  }

  func connectKitchen() async {
    guard let client, !connectingKitchen else { return }
    connectingKitchen = true
    defer { connectingKitchen = false }
    do {
      let start = try await client.startKitchenSignIn()
      guard let url = URL(string: start.url) else { return }
      let code = try await signIn.run(url: url, state: start.state)
      let said = try await client.finishKitchenSignIn(code: code, state: start.state)
      kitchenConnected = true
      await addAndSay(said)
      client.event("kitchen_connected")
    } catch KitchenSignIn.Failure.cancelled {
      return
    } catch {
      add("Crew", "Couldn't connect the kitchen: \(error.localizedDescription)")
      client.event("kitchen_connect_failed", detail: error.localizedDescription)
    }
  }

  // MARK: kitchen mode: food coming out, named once each

  func startKitchen() async {
    guard let client else { await say(CrewError.notSetUp.localizedDescription); return }
    guard !kitchenMode, !shopping else { return }
    do {
      kitchenSession = try await client.startKitchen()
      kitchenMode = true
      pulledOut = []
      await glasses.startCamera()
      await addAndSay("Kitchen mode. Show me the barcode as you pull things out, or say \"Hey Crew, I've got this\" for anything without one.")
      kitchenTask = Task { [weak self] in await self?.watchBarcodes() }
    } catch {
      await say("I couldn't start kitchen mode.")
    }
  }

  /// Barcodes are read on the phone every half second (free). An unknown barcode gets one photo.
  private func watchBarcodes() async {
    var tried = Set<String>()
    while kitchenMode, !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(500))
      guard let client, let session = kitchenSession, !busy, let code = await glasses.readBarcode(), !tried.contains(code) else { continue }
      tried.insert(code)
      guard let r = try? await client.kitchenItem(session, barcode: code) else { tried.remove(code); continue }
      if r.unknownBarcode == true { await kitchenPhoto(); continue }
      await heardItem(r)
    }
  }

  func kitchenPhoto() async {
    guard let client, let session = kitchenSession else { return }
    var jpeg: Data?
    for _ in 0..<10 where jpeg == nil { // up to 2 s for a frame
      jpeg = glasses.takeFrame()
      if jpeg == nil { try? await Task.sleep(for: .milliseconds(200)) }
    }
    guard let jpeg else { await say("I couldn't get a picture from the glasses."); return }
    if let r = try? await client.kitchenItem(session, jpeg: jpeg) { await heardItem(r) }
  }

  private func heardItem(_ r: CrewClient.KitchenItem) async {
    if let item = r.item, r.say != nil { pulledOut.append(item) }
    if let say = r.say { await addAndSay(say) }
  }

  func endKitchen() async {
    guard kitchenMode else { return }
    kitchenMode = false
    kitchenTask?.cancel()
    glasses.stopCamera()
    if let client, let session = kitchenSession, let end = try? await client.endKitchen(session) {
      await addAndSay(end.say)
    }
    kitchenSession = nil
  }

  // MARK: live shopping

  func startShopping() async {
    guard let client else { await say(CrewError.notSetUp.localizedDescription); return }
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

  /// Barcode first: read on the phone (free, no photo sent) and named from the product database.
  /// Only when there's no new barcode in view, or the database doesn't know it, does a photo go.
  private func watchFrames() async {
    var tried = Set<String>()
    while shopping, !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(1500))
      guard let client, let trip, !busy else { continue }
      var said: CrewClient.Said?
      if let code = await glasses.readBarcode(), !tried.contains(code) {
        tried.insert(code)
        said = try? await client.frame(trip: trip, barcode: code)
      }
      if said == nil || said?.unknownBarcode == true, let jpeg = glasses.takeFrame() {
        said = try? await client.frame(trip: trip, jpeg: jpeg)
      }
      if let say = said?.say {
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
