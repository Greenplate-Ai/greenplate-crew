import AVFoundation

/// Speaks the crew's answers. With the glasses connected as a Bluetooth headset, iOS routes
/// playback to their open-ear speakers.
@MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
  private let synth = AVSpeechSynthesizer()
  private var finished: CheckedContinuation<Void, Never>?

  override init() {
    super.init()
    synth.delegate = self
    let audio = AVAudioSession.sharedInstance()
    try? audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
  }

  /// Speaks and returns when done, so the next listen does not hear the crew itself.
  func say(_ text: String) async {
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
