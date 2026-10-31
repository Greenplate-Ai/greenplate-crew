import Foundation

/// Talks to the crew service (src/kitchen/server.ts). Every call carries the app token.
struct CrewClient {
  var baseURL: URL
  var token: String

  struct Run: Decodable {
    let status: String
    let answer: String?
    let spoken: String?
    let steps: [String]
    let usd: Double?
    let lane: String?
  }
  struct Trip: Decodable { let tripId: String; let needs: [String] }
  struct Said: Decodable { let seen: String?; let say: String?; var unknownBarcode: Bool? = nil; var checked: [String]? = nil }

  /// `history` is the chat so far (who, text), so the crew remembers the conversation.
  func ask(_ request: String, mode: String, history: [[String: String]] = []) async throws -> String {
    struct R: Decodable { let runId: String }
    let r: R = try await send("POST", "ask", ["request": request, "mode": mode, "history": history])
    return r.runId
  }

  func run(_ id: String) async throws -> Run { try await send("GET", "runs/\(id)", nil) }

  func answer(_ id: String, yes: Bool) async throws {
    struct Ok: Decodable { let ok: Bool }
    let _: Ok = try await send("POST", "runs/\(id)/answer", ["yes": yes])
  }

  func startShopping(from: String, to: String) async throws -> Trip {
    try await send("POST", "shopping/start", ["from": from, "to": to])
  }

  func frame(trip: String, jpeg: Data) async throws -> Said {
    try await send("POST", "shopping/\(trip)/frame", ["jpegBase64": jpeg.base64EncodedString()])
  }

  /// A barcode read on the phone: no photo sent. unknownBarcode means send a photo instead.
  func frame(trip: String, barcode: String) async throws -> Said {
    try await send("POST", "shopping/\(trip)/frame", ["barcode": barcode])
  }

  struct MealSeen: Decodable { let mealId: String?; let say: String }
  struct MealLogged: Decodable { let logged: Bool; let say: String }

  /// Names what's on the plate; nothing is saved until logMeal(yes: true).
  func mealPhoto(jpeg: Data, date: String, slot: String) async throws -> MealSeen {
    try await send("POST", "meal/photo", ["jpegBase64": jpeg.base64EncodedString(), "date": date, "slot": slot])
  }

  func logMeal(_ id: String, yes: Bool) async throws -> MealLogged {
    try await send("POST", "meal/\(id)/log", ["yes": yes])
  }

  struct KitchenItem: Decodable { let item: String?; let unknownBarcode: Bool?; let say: String? }
  struct KitchenEnd: Decodable { let items: [String]; let say: String }

  /// Kitchen mode: food coming out of the fridge or cupboard, named once each.
  func startKitchen() async throws -> String {
    struct R: Decodable { let sessionId: String }
    let r: R = try await send("POST", "kitchen/start", [:])
    return r.sessionId
  }

  /// A barcode (read on the phone, free) or, when there's none, one photo.
  func kitchenItem(_ session: String, barcode: String? = nil, jpeg: Data? = nil) async throws -> KitchenItem {
    var body: [String: Any] = [:]
    if let barcode { body["barcode"] = barcode }
    if let jpeg { body["jpegBase64"] = jpeg.base64EncodedString() }
    return try await send("POST", "kitchen/\(session)/item", body)
  }

  struct SignInStart: Decodable { let url: String; let state: String }
  struct Health: Decodable { let kitchen: Bool?; let crew: Bool? }

  /// Is the person's GreenplateAi kitchen connected on the service?
  func health() async throws -> Health { try await send("GET", "health", nil) }

  /// "Connect your kitchen": the sign-in page to open, then the code it sent back.
  func startKitchenSignIn() async throws -> SignInStart { try await send("GET", "kitchen/connect", nil) }
  func finishKitchenSignIn(code: String, state: String) async throws -> String {
    struct R: Decodable { let say: String }
    let r: R = try await send("POST", "kitchen/connect", ["code": code, "state": state])
    return r.say
  }

  /// The app's own timings and hiccups, logged by the service for npm run report. Never blocks.
  func event(_ kind: String, ms: Double? = nil, detail: String? = nil) {
    var body: [String: Any] = ["kind": kind]
    if let ms { body["ms"] = ms }
    if let detail { body["detail"] = detail }
    Task { struct Ok: Decodable { let ok: Bool }; let _: Ok? = try? await send("POST", "events", body) }
  }

  func endKitchen(_ session: String) async throws -> KitchenEnd {
    try await send("POST", "kitchen/\(session)/end", [:])
  }

  func checkout(trip: String) async throws -> String? {
    let s: Said = try await send("POST", "shopping/\(trip)/checkout", [:])
    return s.say
  }

  /// ElevenLabs audio for a line, from the crew service. Throws if the service has no voice set up.
  func speak(_ text: String) async throws -> Data {
    var req = URLRequest(url: baseURL.appendingPathComponent("speak"))
    req.httpMethod = "POST"
    req.timeoutInterval = 15
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONSerialization.data(withJSONObject: ["text": text])
    let (data, res) = try await URLSession.shared.data(for: req)
    guard let http = res as? HTTPURLResponse, http.statusCode == 200, !data.isEmpty else {
      throw CrewError.http((res as? HTTPURLResponse)?.statusCode ?? 0, "no voice")
    }
    return data
  }

  private func send<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any]?) async throws -> T {
    var req = URLRequest(url: baseURL.appendingPathComponent(path))
    req.httpMethod = method
    req.timeoutInterval = 30
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let body {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let (data, res) = try await URLSession.shared.data(for: req)
    guard let http = res as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let code = (res as? HTTPURLResponse)?.statusCode ?? 0
      throw CrewError.http(code, String(data: data, encoding: .utf8) ?? "")
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
}

enum CrewError: LocalizedError {
  case http(Int, String)
  case notSetUp
  var errorDescription: String? {
    switch self {
    case let .http(code, body): "Crew service answered \(code): \(body.prefix(120))"
    case .notSetUp: "Add the crew service address and app token in Settings."
    }
  }
}
