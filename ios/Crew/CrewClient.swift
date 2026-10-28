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
  }
  struct Trip: Decodable { let tripId: String; let needs: [String] }
  struct Said: Decodable { let seen: String?; let say: String? }

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

  struct MealSeen: Decodable { let mealId: String?; let say: String }
  struct MealLogged: Decodable { let logged: Bool; let say: String }

  /// Names what's on the plate; nothing is saved until logMeal(yes: true).
  func mealPhoto(jpeg: Data, date: String, slot: String) async throws -> MealSeen {
    try await send("POST", "meal/photo", ["jpegBase64": jpeg.base64EncodedString(), "date": date, "slot": slot])
  }

  func logMeal(_ id: String, yes: Bool) async throws -> MealLogged {
    try await send("POST", "meal/\(id)/log", ["yes": yes])
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
