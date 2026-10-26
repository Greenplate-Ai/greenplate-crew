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
    u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.05
    await withCheckedContinuation { c in
      finished = c
      synth.speak(u)
    }
  }

  nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
    Task { @MainActor in self.finished?.resume(); self.finished = nil }
  }

  nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
    Task { @MainActor in self.finished?.resume(); self.finished = nil }
  }
}
