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

// Split a long recording into short windows for the final pass. One whole-recording request for many
// seconds of continuous speech can come back with only the opening words when the machine is fully loaded
// (the engine stops early under contention; short requests always complete). So a long final is heard in
// windows of at most about maxChunks (about LIVE_PIECE_S), each cut only at a CONFIRMED pause between
// words: a sustained run of about half a second below the speech floor (the same sustained-silence rule
// livePieces uses). A cut at the single quietest frame could still land mid-word in continuous speech and
// split it, and joining the transcripts cannot put the word back; a confirmed pause is a real gap, so the
// boundary never splits a word. When speech runs on with no pause inside the target window, the window is
// extended to the next confirmed pause (or the end) rather than cut mid-word: that one request is slower,
// but it stays whole. Returns [from, to) chunk-index pairs covering the whole recording.
export function finalChunks(recording, maxChunks = Math.floor(LIVE_PIECE_S * recording.rate / FRAME)) {
  const n = recording.chunks.length, per = FRAME / recording.rate, windows = [];
  const need = Math.max(2, Math.ceil(PAUSE_S / per)); // frames of sustained silence that confirm a pause
  const minChunks = Math.max(1, Math.floor(LIVE_CUT_S / per)); // do not cut before this, so windows are not tiny
  let from = 0;
  while (from < n) {
    const target = Math.min(n, from + maxChunks);
    if (target >= n) { windows.push([from, n]); break; }
    // Prefer the latest confirmed pause at or before the target window end: scan [from, target), and each
    // time a run of `need` sub-floor frames completes (and we are past minChunks in), remember its start.
    let cut = 0, run = 0;
    for (let index = from; index < target; index++) {
      if ((recording.levels[index] ?? 1) < VOICE_FLOOR) { if (++run === need && index - need + 1 >= from + minChunks) cut = index - need + 1; }
      else run = 0;
    }
    if (cut > from) { windows.push([from, cut]); from = cut; continue; }
    // No pause inside the window (continuous speech): extend to the next confirmed pause, or to the end.
    let end = n; run = 0;
    for (let index = target; index < n; index++) {
      if ((recording.levels[index] ?? 1) < VOICE_FLOOR) { if (++run === need) { end = index - need + 1; break; } }
      else run = 0;
    }
    windows.push([from, end]);
    from = end;
  }
  return windows;
}

// Seconds of audio that were actually voiced: the frames at or above the speech floor. Leading, trailing and
// in-between silence do not count, so a short phrase spoken inside a long silence is measured by how much was
// said, not by the wall-clock length of the recording.
export function voicedSeconds(recording) {
  const per = FRAME / recording.rate; let voiced = 0;
  for (const level of recording.levels) if ((level ?? 0) >= VOICE_FLOOR) voiced++;
  return voiced * per;
}

// Does a final answer look suspiciously short for how much was actually spoken? This is only a retry HINT: a
// cold engine can answer the first pass with just the opening words (seen once: 5 of 30 words after a restart),
// so the caller re-hears once (the engine is warm by then), keeps the fuller answer, and discards it only if it
// is STILL far too short for a long voiced span. It is measured against voiced speech time (voicedSeconds),
// never the whole recording, so a short phrase wrapped in long silence is never flagged. Scripts with spaces
// between words are measured by word count; scripts written with no spaces between words (Khmer, Chinese,
// Japanese) by character count, so a complete Khmer transcript (one long run with few or no spaces) is never
// mistaken for a single truncated word. The floors are far below real dictation (2-3 words/s, many more
// chars/s), so only a clearly cut-off answer is flagged, and a non-empty plausible transcript never is.
export const MIN_WORDS_PER_S = 0.5, MIN_CHARS_PER_S = 1.5, MIN_CHECK_S = 8;
const SPACELESS_SCRIPT = /[ក-៿぀-ヿ㐀-䶿一-鿿]/g; // Khmer, Kana, CJK ideographs
export function looksTruncated(text, voicedSeconds) {
  if (!(voicedSeconds >= MIN_CHECK_S)) return false; // too little speech to judge a cut-off
  const trimmed = String(text || '').trim();
  if (!trimmed) return true; // nothing came back for a long voiced span
  const bare = trimmed.replace(/\s+/g, '');
  const spaceless = (trimmed.match(SPACELESS_SCRIPT) || []).length * 2 >= bare.length; // mostly a no-space script
  if (spaceless) return bare.length < voicedSeconds * MIN_CHARS_PER_S;
  return trimmed.split(/\s+/).filter(Boolean).length < voicedSeconds * MIN_WORDS_PER_S;
}
