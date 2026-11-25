# Voice timing fixtures

Saved speech used by `test/voice-timing.mjs` so QA replays the exact same audio every run.

- `en5.wav` - 5 words: "Open the project and run tests." (~2.7s). Too short to commit a live cut, so the harness runs the whole-recording final pass.
- `en30.wav` - 30 words, continuous (pause-free): "Please open the project folder, pull the latest changes from the main branch, install the packages, start the development server on a free port, then run the full test suite and report any failures." (~12.8s). No sustained pause, so again the whole-recording final pass.
- `en-pauses.wav` - five short phrases with a clear pause between each ("First, open the project folder. Then pull the latest changes. ..."), ~19.5s. The pauses fall below the speech floor, so livePieces commits cuts and the harness runs the tail-only final pass. This is the clip that exercises the pause-cut and tail-only path.

All three are 16-bit mono PCM at 22050 Hz, synthesized offline with the Windows voice (`System.Speech`), so they are deterministic and need no network.

Khmer: no offline Khmer voice is available on this machine, so there is no committed Khmer clip yet. To add one, record a short Khmer sentence as 16-bit mono WAV and save it here as `km.wav`, then run the harness with `km`. The harness and tests already accept it.
