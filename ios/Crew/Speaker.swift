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
    try? audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
    try? audio.setActive(true) // ready at launch, so the first line doesn't wait for audio to start up
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

  /// Plays audio made by the crew service (the ElevenLabs voice). Returns false if it can't play.
  func play(_ audio: Data) async -> Bool {
    try? AVAudioSession.sharedInstance().setActive(true)
    guard let p = try? AVAudioPlayer(data: audio) else { return false }
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
