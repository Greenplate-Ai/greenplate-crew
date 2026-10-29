import AuthenticationServices
import Foundation
import Network
import UIKit

/// "Connect your kitchen": the GreenplateAi sign-in, done on the phone. GreenplateAi sends the
/// person back to a listener inside this app for a moment (127.0.0.1:8765, the address the sign-in
/// is registered with); the code goes to the crew service, which keeps the sign-in from then on.
/// The sheet shares Safari's cookies, so if GreenplateAi is already signed in there it's one tap.
@MainActor
final class KitchenSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  enum Failure: LocalizedError {
    case cancelled, noCode, listener(String)
    var errorDescription: String? {
      switch self {
      case .cancelled: return "Sign-in was closed before it finished."
      case .noCode: return "GreenplateAi didn't send the sign-in back. Try again."
      case .listener(let why): return "Couldn't start the sign-in: \(why)"
      }
    }
  }

  private var listener: NWListener?
  private var session: ASWebAuthenticationSession?
  private var waiting: CheckedContinuation<String, Error>?

  /// Opens the sign-in page; returns the code GreenplateAi sends back for this state.
  func run(url: URL, state: String) async throws -> String {
    defer { stop() }
    return try await withCheckedThrowingContinuation { c in
      waiting = c
      do { try listen(state: state) } catch { finish(.failure(Failure.listener(error.localizedDescription))); return }
      // The listener answers GreenplateAi's redirect with a jump to this scheme, which closes the sheet.
      let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "ai.greenplate.crew") { [weak self] _, error in
        Task { @MainActor in
          if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin { self?.finish(.failure(Failure.cancelled)) }
          else { self?.finish(.failure(Failure.noCode)) } // only reached if the code never came
        }
      }
      s.presentationContextProvider = self
      s.prefersEphemeralWebBrowserSession = false
      session = s
      s.start()
    }
  }

  private func listen(state: String) throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 8765)
    params.allowLocalEndpointReuse = true
    let l = try NWListener(using: params)
    l.newConnectionHandler = { [weak self] conn in
      conn.start(queue: .main)
      conn.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, _, _ in
        let line = String(decoding: data ?? Data(), as: UTF8.self).split(separator: "\r\n").first.map(String.init) ?? ""
        let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? ""
        let items = URLComponents(string: "http://127.0.0.1\(path)")?.queryItems ?? []
        let code = items.first { $0.name == "code" }?.value
        let ok = code != nil && items.first { $0.name == "state" }?.value == state
        let reply = "HTTP/1.1 302 Found\r\nLocation: ai.greenplate.crew://connected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        conn.send(content: Data(reply.utf8), completion: .contentProcessed { _ in conn.cancel() })
        Task { @MainActor in
          guard let self else { return }
          if ok, let code { self.finish(.success(code)) }
        }
      }
    }
    l.start(queue: .main)
    listener = l
  }

  private func finish(_ result: Result<String, Error>) {
    guard let c = waiting else { return }
    waiting = nil
    c.resume(with: result)
    session?.cancel()
  }

  private func stop() {
    listener?.cancel()
    listener = nil
    session = nil
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }
  }
}
