# Voice timing fixtures

Saved speech used by `test/voice-timing.mjs` so QA replays the exact same audio every run.

- `en5.wav` - 5 words: "Open the project and run tests." (~2.7s)
- `en30.wav` - 30 words: "Please open the project folder, pull the latest changes from the main branch, install the packages, start the development server on a free port, then run the full test suite and report any failures." (~12.8s)

Both are 16-bit mono PCM at 22050 Hz, synthesized offline with the Windows voice (`System.Speech`), so they are deterministic and need no network.

Khmer: no offline Khmer voice is available on this machine, so there is no committed Khmer clip yet. To add one, record a short Khmer sentence as 16-bit mono WAV and save it here as `km.wav`, then run the harness with `km`. The harness and tests already accept it.
