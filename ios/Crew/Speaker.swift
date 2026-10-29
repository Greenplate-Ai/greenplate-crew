import AVFoundation
import AudioToolbox

/// Speaks the crew's answers. With the glasses connected as a Bluetooth headset, iOS routes
/// playback to their open-ear speakers.
@MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
  private let synth = AVSpeechSynthesizer()
  private var finished: CheckedContinuation<Void, Never>?
  private var player: AVAudioPlayer?
  private var playDone: CheckedContinuation<Void, Never>?
  /// Set when the last line came from the natural (server) voice, so Settings can say so.
  private(set) var lastWasNatural = false

  override init() {
    super.init()
    synth.delegate = self
    let audio = AVAudioSession.sharedInstance()
    // Mixes with music (no ducking): the session stays active all the time for keepAlive().
    try? audio.setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers])
    try? audio.setActive(true) // ready at launch, so the first line doesn't wait for audio to start up
    keepAlive()
    // A call or Siri stops the silence; start it again afterwards.
    NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
      guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
      Task { @MainActor in
        try? AVAudioSession.sharedInstance().setActive(true)
        self?.silence?.play()
      }
    }
  }

  private var silence: AVAudioPlayer?

  /// Plays silence on a loop so iOS keeps the app running when it's not on screen: otherwise it is
  /// suspended a few seconds after you leave it, and "crew, ..." on the glasses goes unheard.
  func keepAlive() {
    guard silence == nil, let p = try? AVAudioPlayer(data: Self.silentWav()) else { return }
    p.numberOfLoops = -1
    p.volume = 0
    p.play()
    silence = p
  }

  /// One second of 8 kHz mono 16-bit silence as a WAV file.
  private static func silentWav() -> Data {
    let rate: UInt32 = 8000, samples = 8000
    var d = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + samples * 2)); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
    d.append(contentsOf: Array("data".utf8)); u32(UInt32(samples * 2)); d.append(Data(count: samples * 2))
    return d
  }

  /// Speaks and returns when done, so the next listen does not hear the crew itself.
  func say(_ text: String) async {
    lastWasNatural = false
    try? AVAudioSession.sharedInstance().setActive(true)
    finished?.resume()
    let u = AVSpeechUtterance(string: text)
    u.voice = Self.bestVoice()
    u.rate = AVSpeechUtteranceDefaultSpeechRate
    u.prefersAssistiveTechnologySettings = false
    await withCheckedContinuation { c in
      finished = c
      synth.speak(u)
    }
  }

  /// A short tone in place of speech when the crew's voice can't be reached.
  func chime() { AudioServicesPlaySystemSound(1057) }

  private var tone: AVAudioPlayer?

  /// A soft rising two-note tone: the crew is listening for your next sentence. Played like the
  /// voice, so it comes out of the glasses, and on its own player so it never cuts a line off.
  func listeningChime() {
    guard let p = try? AVAudioPlayer(data: Self.chimeWav) else { return }
    p.volume = 0.6
    tone = p
    p.play()
  }

  private static let chimeWav: Data = {
    let rate = 16_000.0
    var pcm: [Int16] = []
    for (freq, seconds) in [(880.0, 0.08), (1318.5, 0.13)] {
      let n = Int(rate * seconds)
      for i in 0..<n {
        let fade = min(1, Double(i) / 160) * (1 - Double(i) / Double(n)) // quick start, soft end
        pcm.append(Int16(sin(2 * .pi * freq * Double(i) / rate) * fade * 9_000))
      }
    }
    return wav(pcm, rate: UInt32(rate))
  }()

  /// 16-bit mono samples as a WAV file.
  private static func wav(_ samples: [Int16], rate: UInt32) -> Data {
    var d = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    let bytes = UInt32(samples.count * 2)
    d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
    d.append(contentsOf: Array("data".utf8)); u32(bytes)
    for s in samples { withUnsafeBytes(of: s.littleEndian) { d.append(contentsOf: $0) } }
    return d
  }

  /// Plays audio made by the crew service (the ElevenLabs voice). Returns false if it can't play.
  func play(_ audio: Data) async -> Bool {
    guard let p = try? AVAudioPlayer(data: audio) else { return false }
    duckMusic(true)
    defer { duckMusic(false) }
    player?.stop() // a newer line (the answer) replaces one still playing ("One sec...")
    finishPlaying()
    player = p
    p.delegate = self
    lastWasNatural = true
    await withCheckedContinuation { c in
      playDone = c
      if !p.play() { finishPlaying(); return }
      // Never leave the crew waiting if iOS doesn't report the end (route change, interruption).
      let limit = p.duration + 1.5
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(limit))
        if self?.player === p { self?.finishPlaying() }
      }
    }
    return true
  }

  /// Turns other apps' music down while the crew talks, and back up after. iOS only restores the
  /// music's volume when the session deactivates, so it's switched off and straight back on (the
  /// silent keep-alive loop restarts with it).
  private func duckMusic(_ on: Bool) {
    let audio = AVAudioSession.sharedInstance()
    if on {
      try? audio.setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers, .duckOthers])
      try? audio.setActive(true)
    } else {
      guard playDone == nil else { return } // a newer line is already playing
      try? audio.setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers])
      try? audio.setActive(false, options: .notifyOthersOnDeactivation)
      try? audio.setActive(true)
      silence?.play()
    }
  }

  /// Resumes whoever is waiting on playback, exactly once.
  private func finishPlaying() {
    let c = playDone
    playDone = nil
    c?.resume()
  }

  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in self.finishPlaying() }
  }

  nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    Task { @MainActor in self.finishPlaying() }
  }

  /// The most natural English voice on this phone: Premium, then Enhanced, then the default.
  /// Premium and Enhanced voices are free downloads in Settings > Accessibility > Spoken Content > Voices.
  static func bestVoice() -> AVSpeechSynthesisVoice? {
    let english = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("en-US") }
    if let v = english.first(where: { $0.quality == .premium }) { return v }
    if let v = english.first(where: { $0.quality == .enhanced }) { return v }
    return AVSpeechSynthesisVoice(language: "en-US")
  }

  /// "Zoe (Premium)", shown in Settings so it's clear which voice is in use.
  var voiceName: String {
    guard let v = Self.bestVoice() else { return "System default" }
    let q: String
    switch v.quality {
    case .premium: q = "Premium"
    case .enhanced: q = "Enhanced"
    default: q = "Basic"
    }
    return "\(v.name) (\(q))"
  }

  nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
    Task { @MainActor in self.finished?.resume(); self.finished = nil }
  }

  nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
    Task { @MainActor in self.finished?.resume(); self.finished = nil }
  }
}
