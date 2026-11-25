// Browser-free logic for free on-computer live dictation, shared so the app and the QA timing harness
// run the exact same decisions. Two pure functions, no DOM and no engine:
//   livePieces - while the person talks, where to cut a live piece at a sustained pause.
//   finalPass  - on stop, which final pass to run (the uncommitted tail only, or the whole recording).
// public/chat-composer.js (the app) and test/voice-timing.mjs (the harness) both import from here, so a
// change to either decision moves in one place and the harness can prove which path the app would take.
//
// A "recording" here is just { rate, chunks, levels, liveFrom?, liveKept? }: chunks are Float32Array
// frames of mic audio (4096 samples each, like the recorder's ScriptProcessor), levels[i] is that
// chunk's RMS loudness (Math.sqrt(mean(sample^2)), the same number recorder.js stores).
export const LIVE_EVERY_MS = 1500, LIVE_PIECE_S = 5, LIVE_CUT_S = 2.5, VOICE_FLOOR = 0.012, PAUSE_S = 0.5, FRAME = 4096;

// The on-computer engine has no live results, so the recording is turned into words piece by piece while
// the person talks. Every tick only the part since the last finished piece is heard. Once that part is
// longer than LIVE_PIECE_S it is cut at a sustained pause between words (a run of about half a second
// below the speech floor) found between LIVE_CUT_S and LIVE_PIECE_S in; the words before the cut are kept
// and the next pieces start from there. Words are committed only at such a pause: one quiet chunk can be
// a soft syllable in quiet speech, so cutting on it would split a word that the tail-only final pass can
// no longer repair. No sustained pause means cut 0: nothing is committed and the whole part keeps being
// heard (the final pass then falls back to the whole recording).
export function livePieces(recording, from = 0) {
  const per = FRAME / recording.rate, end = recording.chunks.length;
  if ((end - from) * per <= LIVE_PIECE_S) return { cut: 0, end };
  const first = from + Math.ceil(LIVE_CUT_S / per), last = Math.min(end, from + Math.floor(LIVE_PIECE_S / per));
  const need = Math.max(2, Math.ceil(PAUSE_S / per));
  let run = 0;
  for (let index = first; index < last; index++) {
    if ((recording.levels[index] ?? 1) < VOICE_FLOOR) { if (++run >= need) return { cut: index - need + 1, end }; }
    else run = 0;
  }
  return { cut: 0, end };
}

// finishMic's final-pass decision, made pure so the app and the QA harness run the same choice. Given the
// live state the loop left on the recording (liveFrom = chunk index of the last committed cut, liveKept =
// the words already committed), say which pass to run on stop:
//   { path: 'tail',  from, kept, tail } - a pause was committed; re-hear only the uncommitted tail (one
//                                         live window at most) and join it to the kept words.
//   { path: 'whole', from: 0, kept: '' } - nothing committed (short clip, or no pause); hear it all.
// The caller does the real hearing; this only picks the path and the audio slice.
export function finalPass(recording) {
  const from = recording.liveFrom || 0, kept = (recording.liveKept || '').trim();
  const tail = from > 0 ? recording.chunks.slice(from) : [];
  if (tail.length) return { path: 'tail', from, kept, tail };
  return { path: 'whole', from: 0, kept: '', tail: recording.chunks };
}

// Seconds of audio in a recording, from its frame count and sample rate.
export function audioSeconds(recording) { return recording.chunks.length * FRAME / recording.rate; }

// A cold engine can answer the first final pass with only the opening words (seen once: 5 of 30 words on
// the first run after a restart). That is data loss, so a final answer that is far too short for the audio
// is treated as suspect: the caller hears it once more (the engine is warm by then) and keeps the fuller
// answer, and errors rather than finalizing a partial one. Real dictation runs 2-3 words/s; the floor here
// (MIN_WORDS_PER_S) is far below that, and only audio past MIN_CHECK_S is checked, so slow or short speech
// is never flagged, only a clearly cut-off answer.
export const MIN_WORDS_PER_S = 0.5, MIN_CHECK_S = 8;
export function looksTruncated(text, audioSeconds) {
  if (!(audioSeconds >= MIN_CHECK_S)) return false;
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return words < audioSeconds * MIN_WORDS_PER_S;
}
