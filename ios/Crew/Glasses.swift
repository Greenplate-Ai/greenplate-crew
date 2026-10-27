import Foundation
import MWDATCamera
import MWDATCore
import MWDATInputs
import MWDATSpeech
import UIKit

/// Everything that touches the glasses: registration, one device session, on-glasses speech,
/// the capture button, the camera (only while shopping), and "Hey Meta, start Kitchen Crew".
@MainActor
final class Glasses: ObservableObject {
  enum Link: Equatable { case notRegistered, registering, registered, connecting, connected, failed(String) }

  @Published private(set) var link: Link = .notRegistered
  @Published private(set) var heard: String = ""
  @Published private(set) var cameraOn = false
  @Published private(set) var registered = false

  /// A finished sentence heard by the glasses' microphones.
  var onHeard: ((String) -> Void)?
  /// A short press of the capture button.
  var onButton: (() -> Void)?
  /// "Hey Meta, start Kitchen Crew".
  var onLaunched: (() -> Void)?

  private var session: DeviceSession?
  private var camera: Camera?
  private var latestFrame: VideoFrame?
  private var tokens: [any AnyListenerToken] = []
  private var cameraTokens: [any AnyListenerToken] = []
  private var tasks: [Task<Void, Never>] = []
  private var voice: VoiceInvocationsStream?

  func configure() {
    do { try Wearables.configure() } catch { link = .failed("Toolkit setup: \(error)") }
    tasks.append(Task { [weak self] in
      for await state in Wearables.shared.registrationStateStream() {
        guard let self else { return }
        switch state {
        case .registered:
          self.registered = true
          if self.session == nil { self.link = .registered }
        case .registering: self.link = .registering
        default: if self.session == nil { self.link = .notRegistered }
        }
      }
    })
  }

  func register() async {
    do {
      try await Wearables.shared.startRegistration()
    } catch let e as RegistrationError {
      switch e {
      case .alreadyRegistered:
        registered = true
        if session == nil { link = .registered }
      case .configurationInvalid: link = .failed("The app's Meta setup is invalid. This needs a new build, not a retry.")
      case .metaAINotInstalled: link = .failed("Install the Meta AI app, then tap Register.")
      case .networkUnavailable: link = .failed("No internet connection. Check Wi-Fi, then tap Register.")
      default: link = .failed("Registration failed. Open the Meta AI app, then tap Register again.")
      }
    } catch {
      link = .failed("Registration failed: \(error.localizedDescription)")
    }
  }

  func handle(url: URL) async {
    _ = try? await Wearables.shared.handleUrl(url)
  }

  /// Opens a session on the glasses and starts listening and watching the button.
  func connect() async {
    guard session == nil else { return }
    link = .connecting
    do {
      // Permission requests fail with "no device" unless the glasses are already known and connected,
      // so wait for them first (up to 15 s).
      guard await Self.waitForGlasses(seconds: 15) else { throw GlassesError.noGlasses }
      if try await Wearables.shared.checkPermissionStatus(.microphone) != .granted {
        _ = try await Wearables.shared.requestPermission(.microphone)
      }
      // The camera is only needed on a shopping trip; asked for in startCamera().
      let s = try Wearables.shared.createSession(deviceSelector: AutoDeviceSelector(wearables: Wearables.shared))
      session = s
      try s.start()
      for await state in s.stateStream() {
        if state == .started { break }
        if state == .stopped { throw GlassesError.stopped }
      }
      attachSpeech(s)
      attachButton(s)
      link = .connected
      tasks.append(Task { [weak self] in
        for await state in s.stateStream() where state == .stopped {
          self?.dropSession()
          return
        }
      })
    } catch {
      dropSession()
      link = .failed(Self.explain(error))
    }
  }

  /// True once the Meta AI app reports at least one pair of glasses.
  private static func waitForGlasses(seconds: Double) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        for await ids in Wearables.shared.devicesStream() where !ids.isEmpty { return true }
        return false
      }
      group.addTask {
        try? await Task.sleep(for: .seconds(seconds))
        return false
      }
      let found = await group.next() ?? false
      group.cancelAll()
      return found
    }
  }

  /// Plain words for what went wrong, instead of the raw error value.
  static func explain(_ error: Error) -> String {
    if let e = error as? GlassesError {
      switch e {
      case .noGlasses: return "Glasses not found. Turn them on, open the Meta AI app and check they show as connected, then tap Connect."
      case .stopped: return "The glasses ended the session. Tap Connect to try again."
      }
    }
    if let e = error as? PermissionError {
      switch e {
      case .noDevice: return "No glasses registered yet. Tap Register, then Connect."
      case .noDeviceWithConnection: return "Glasses are off or not connected. Open the Meta AI app, connect them, then tap Connect."
      case .connectionError: return "Lost the connection to the glasses. Tap Connect to try again."
      case .metaAINotInstalled: return "The Meta AI app is not installed on this phone."
      case .requestInProgress: return "A permission request is already open in the Meta AI app. Finish it there."
      case .requestTimeout: return "The permission request timed out. Tap Connect and approve it in the Meta AI app."
      default: return "Permission error on the glasses (\(e)). Tap Connect to try again."
      }
    }
    return "Couldn't connect: \(error.localizedDescription)"
  }

  func disconnect() {
    stopCamera()
    session?.stop()
    dropSession()
  }

  private func dropSession() {
    session = nil
    camera = nil
    tokens.removeAll()
    cameraTokens.removeAll()
    cameraOn = false
    if case .connected = link { link = .registered }
  }

  private func attachSpeech(_ s: DeviceSession) {
    guard let speech = try? s.addSpeech() else { return }
    speech.transcriptionPublisher.listen { [weak self] result in
      Task { @MainActor in
        guard let self else { return }
        self.heard = result.text
        if result.isFinal, !result.text.isEmpty { self.onHeard?(result.text) }
      }
    }.store(into: &tokens)
    speech.start()
  }

  private func attachButton(_ s: DeviceSession) {
    let config = InputsConfiguration(sources: [.captureButton], consumeBack: false)
    guard let inputs = try? s.addInputs(configuration: config) else { return }
    tasks.append(Task { [weak self] in
      for await event in inputs.events {
        if case let .capture(press, source, _) = event, press == .shortPress, source == .captureButton {
          self?.onButton?()
        }
      }
    })
  }

  // MARK: camera, only during a shopping trip

  func startCamera() async {
    guard let s = session, camera == nil else { return }
    if (try? await Wearables.shared.checkPermissionStatus(.camera)) != .granted {
      _ = try? await Wearables.shared.requestPermission(.camera)
    }
    let config = StreamConfiguration(videoCodec: .raw, resolution: .medium, frameRate: 2)
    guard let cam = try? s.addCamera(config: config) else { return }
    camera = cam
    cam.stream.videoFramePublisher.listen { [weak self] frame in
      Task { @MainActor in self?.latestFrame = frame }
    }.store(into: &cameraTokens)
    cam.stream.start()
    cameraOn = true
  }

  /// The newest frame as JPEG, then forgotten. Nothing is written to disk.
  func takeFrame() -> Data? {
    guard let frame = latestFrame else { return nil }
    latestFrame = nil
    return frame.makeUIImage()?.jpegData(compressionQuality: 0.6)
  }

  func stopCamera() {
    camera?.stream.stop()
    camera = nil
    latestFrame = nil
    cameraTokens.removeAll()
    cameraOn = false
  }

  // MARK: "Hey Meta, start Kitchen Crew" (needs the app set up in the Wearables Developer Center)

  func listenForLaunch() {
    guard voice == nil, let stream = try? VoiceInvocationsStream(wearables: Wearables.shared) else { return }
    voice = stream
    stream.invocationsPublisher.listen { [weak self] invocation in
      guard let launch = invocation as? LaunchApp else { return }
      Task { @MainActor in
        _ = await launch.responseHandle.sendSuccess(actionOutput: nil)
        self?.onLaunched?()
      }
    }.store(into: &tokens)
    tasks.append(Task { [weak self] in
      for await devices in Wearables.shared.devicesStream() {
        guard let first = devices.first, let self, let voice = self.voice else { continue }
        try? voice.start(deviceIdentifier: first)
        return
      }
    })
  }
}

enum GlassesError: Error { case stopped, noGlasses }

private extension AnyListenerToken {
  func store(into list: inout [any AnyListenerToken]) { list.append(self) }
}
