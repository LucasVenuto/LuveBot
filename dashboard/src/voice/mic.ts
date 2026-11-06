// dashboard/src/voice/mic.ts
// The ONLY place that asks for the microphone (contract v0.7 section 4.1). It is called from the Radio button's gesture handlers
// (pointerdown, or Space/Enter keydown) and the Call button's click, and nowhere else: never on load, on focus or from a Bot's message.
// A sweep test refuses any other call site of getUserMedia in dashboard/src.

/** Whether this page may use a microphone at all: the browser only offers one on HTTPS (or localhost). */
export function micPossible(): boolean {
  return typeof window !== "undefined" && window.isSecureContext === true && !!navigator.mediaDevices?.getUserMedia;
}

/** Opens the microphone for one recording or one call (`audio` says how: a call asks for echo cancellation). The caller stops every
 *  track when it is done (track.stop()). */
export function openMic(audio: MediaTrackConstraints | true = true): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio, video: false });
}
