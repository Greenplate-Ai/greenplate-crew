import Foundation
import MWDATCamera
import MWDATCore
import MWDATInputs
import MWDATSpeech
import UIKit
import Vision

/// Everything that touches the glasses: registration, one device session, on-glasses speech,
/// the capture button, the camera (only while shopping), and "Hey Meta, start Kitchen Crew".
@MainActor
final class Glasses: ObservableObject {
  enum Link: Equatable { case notRegistered, registering, registered, connecting, connected, failed(String) }

  @Published private(set) var link: Link = .notRegistered
  @Published private(set) var heard: String = ""
  @Published private(set) var cameraOn = false
  /// True while the glasses' speech recognizer is running and can hear "crew, ...".
  @Published private(set) var listening = false
  @Published private(set) var registered = false
  /// What the Meta AI app reports for each pair: "RB Meta 01LT: connected, compatible".
  @Published private(set) var deviceReport: [String] = []

  /// A finished sentence heard by the glasses' microphones.
  var onHeard: ((String) -> Void)?
  /// Someone is mid-sentence (a partial transcript arrived).
  var onHearing: (() -> Void)?
  /// A short press of the capture button.
  var onButton: (() -> Void)?
  /// Press and hold of the capture button.
  var onLongPress: (() -> Void)?
  /// "Hey Meta, start Kitchen Crew".
  var onLaunched: (() -> Void)?

  private var session: DeviceSession?
  private var speech: Speech?
  private var speechStarted = false
  private var reviving: Task<Void, Never>?
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
          let wasRegistered = self.registered
          self.registered = true
          if self.session == nil { self.link = .registered }
          // No extra tap: connect as soon as registration completes (or on launch if already registered).
          if !wasRegistered { Task { await self.connect() } }
        case .registering: self.link = .registering
        default: if self.session == nil { self.link = .notRegistered }
        }
      }
    })
  }

  /// The one setup action: register if needed (Meta AI opens and returns), otherwise connect.
  func setUp() async {
    if registered { await connect() } else { await register() }
  }

  /// Called when the app comes to the foreground: reconnect quietly if registered and not connected.
  func resume() async {
    guard registered else { return }
    switch link {
    case .connected, .connecting: return
    default: await connect()
    }
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
    userDisconnected = false
    link = .connecting
    do {
      // Permission requests fail with "no device" unless the glasses are already known and connected,
      // so wait for them first (up to 15 s).
      guard await Self.waitForGlasses(seconds: 15) else { throw GlassesError.noGlasses }
      if try await Wearables.shared.checkPermissionStatus(.microphone) != .granted {
        _ = try await Wearables.shared.requestPermission(.microphone)
      }
      // The camera is only needed on a shopping trip; asked for in startCamera().
      let device = try pickConnectedDevice()
      let s = try Wearables.shared.createSession(deviceSelector: SpecificDeviceSelector(device: device))
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
        for await state in s.stateStream() {
          guard let self else { return }
          switch state {
          case .stopped:
            // Glasses folded, taken off, or the session cut while off-screen: Meta needs a new
            // session each time, so start one as soon as they're back - no need to open the app.
            self.dropSession()
            self.reconnectWhenBack()
            return
          case .paused:
            self.listening = false
          case .started:
            // Back from a pause (glasses off, then on): bring the recognizer back.
            if self.speech?.state == .stopped { self.reviveSpeech() }
          default:
            break
          }
        }
      })
    } catch {
      dropSession()
      link = .failed(Self.explain(error))
      reconnectWhenBack() // glasses off or out of range: keep trying quietly
    }
  }

  /// Refreshes deviceReport and returns the first pair that is connected and compatible.
  private func pickConnectedDevice() throws -> DeviceIdentifier {
    let ids = Wearables.shared.devices
    var report: [String] = []
    var pick: DeviceIdentifier?
    var incompatible: String?
    for id in ids {
      guard let d = Wearables.shared.deviceForIdentifier(id) else { continue }
      let compat = d.compatibility()
      report.append("\(d.nameOrId()): \(d.linkState), \(compat)")
      if d.linkState == .connected {
        if compat == .compatible { if pick == nil { pick = id } } else { incompatible = "\(d.nameOrId()) needs an update (\(compat))" }
      }
    }
    deviceReport = report
    if let pick { return pick }
    if let incompatible { throw GlassesError.incompatible(incompatible) }
    throw GlassesError.noGlasses
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
      case let .incompatible(why): return why + ". Update the glasses in the Meta AI app, then try again."
      }
    }
    if let e = error as? DeviceSessionError {
      switch e {
      case .noEligibleDevice: return "No usable glasses: they look disconnected, off, or incompatible. Check they show connected in Meta AI."
      case .datAppOnTheGlassesUpdateRequired: return "The glasses need an update for developer apps. Update them in the Meta AI app."
      case .insufficientSDKVersion: return "This app's Meta toolkit is too old for the glasses' software. The app needs a new build."
      case .sessionAlreadyExists: return "A session is already open. Tap Disconnect, then connect again."
      case .batteryCritical: return "Glasses battery is critically low. Charge them, then connect."
      default: return "The glasses refused the session (\(e.description)). Tap Try connecting."
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

  private var reconnecting: Task<Void, Never>?
  private var userDisconnected = false

  /// Tries a new session every 10 s until the glasses are back (connect() itself waits up to 15 s
  /// for them). Runs off-screen too, because the silent audio loop keeps the app alive.
  func reconnectWhenBack() {
    guard reconnecting == nil, registered, !userDisconnected else { return }
    reconnecting = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, self.session == nil, !self.userDisconnected else { break }
        await self.connect()
        if self.session != nil { break }
        try? await Task.sleep(for: .seconds(10))
      }
      self?.reconnecting = nil
    }
  }

  func disconnect() {
    userDisconnected = true
    reconnecting?.cancel()
    stopCamera()
    session?.stop()
    dropSession()
  }

  private func dropSession() {
    session = nil
    speech = nil
    listening = false
    reviving?.cancel()
    reviving = nil
    camera = nil
    tokens.removeAll()
    cameraTokens.removeAll()
    cameraOn = false
    if case .connected = link { link = .registered }
  }

  private func attachSpeech(_ s: DeviceSession) {
    guard let sp = try? s.addSpeech() else { return }
    speech = sp
    speechStarted = false
    sp.transcriptionPublisher.listen { [weak self] result in
      Task { @MainActor in
        guard let self else { return }
        self.heard = result.text
        if result.isFinal, !result.text.isEmpty { self.onHeard?(result.text) }
        else if !result.text.isEmpty { self.onHearing?() }
      }
    }.store(into: &tokens)
    // The recognizer stops on its own (silence, a photo, the glasses coming off). Meta's sample
    // starts it again; so do we. "stopped" is also its first state, so only revive after a start.
    sp.statePublisher.listen { [weak self] state in
      Task { @MainActor in
        guard let self else { return }
        switch state {
        case .started:
          self.speechStarted = true
          self.listening = true
        case .stopped:
          self.listening = false
          if self.speechStarted { self.reviveSpeech() }
        default:
          break
        }
      }
    }.store(into: &tokens)
    sp.start()
    reviveSpeech()
  }

  /// Keeps the recognizer running for as long as the session is alive: every 2 s, if it has
  /// stopped (silence, the crew's voice, the glasses idling), start it again. It never gives up,
  /// because a recognizer left off is what made "crew" stop working after the first answer.
  func reviveSpeech() {
    guard reviving == nil else { return }
    reviving = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(2))
        guard let self, let sp = self.speech, self.session != nil else { break }
        if sp.state == .stopped { sp.start() }
      }
      self?.reviving = nil
    }
  }

  private func attachButton(_ s: DeviceSession) {
    let config = InputsConfiguration(sources: [.captureButton], consumeBack: false)
    guard let inputs = try? s.addInputs(configuration: config) else { return }
    tasks.append(Task { [weak self] in
      for await event in inputs.events {
        guard case let .capture(press, source, _) = event, source == .captureButton else { continue }
        if press == .shortPress {
          self?.onButton?()
        } else if String(describing: press).lowercased().contains("long") {
          self?.onLongPress?()
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

  /// A grocery barcode in the newest frame, read on the phone with Apple's Vision (no network,
  /// no model). Leaves the frame in place so a photo can still be taken from it.
  func readBarcode() async -> String? {
    guard let image = latestFrame?.makeUIImage()?.cgImage else { return nil }
    return await Task.detached(priority: .utility) {
      let request = VNDetectBarcodesRequest()
      request.symbologies = [.ean13, .ean8, .upce, .code128]
      try? VNImageRequestHandler(cgImage: image).perform([request])
      return (request.results ?? []).filter { $0.confidence > 0.8 }.compactMap(\.payloadStringValue).first
    }.value
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

enum GlassesError: Error { case stopped, noGlasses, incompatible(String) }

private extension AnyListenerToken {
  func store(into list: inout [any AnyListenerToken]) { list.append(self) }
}
