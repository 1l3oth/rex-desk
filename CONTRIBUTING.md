# Contributing

New to the project? Start with [docs/ONBOARDING.md](docs/ONBOARDING.md).

## How changes reach master

- The owner's two accounts, `1l3oth` and `DaraBoth`, push to `master` directly and restart their own Rex Desk.
- Everyone else forks the repository and opens a pull request from the fork. GitHub accepts it into `master` only through a pull request whose CI check passes.
- CI runs `npm test` and `npm run test:browser` on Windows for every pull request and every push to `master`.
- The repository owner reviews and merges.

## A good pull request

- One change per pull request, small enough to review in one sitting.
- The template is filled in: what changes, why, and how you tested it, with screenshots for anything people see.
- New behavior comes with a test in `test/`. UI changes keep `scripts/browser-test.js` passing, and extend it when a flow changes.
- Docs follow behavior: README for features, `DESIGN.md` for UI, `PRODUCT.md` for product rules.
- Commit messages follow the existing history: `feat:`, `fix:`, `docs:`, `test:`, or `chore:`, then a plain sentence.
- Commits use your own Git identity, without AI co-author lines.

## Code

- Match the surrounding code: Node 24 ES modules, no build step for `public/`, and the existing naming and comment style.
- Dashboard text is plain English, written for someone who is not a developer.
- Keep secrets out of code, tests, logs, and screenshots. Keys belong in Settings, where they are encrypted; agents use test-account placeholders. `.local/` is never committed.
- Develop with a separate data folder (`REX_DATA_DIR`) and port (`PORT`), so tests and experiments never touch a real workspace.

## Security

Report security problems privately to the repository owner. Do not open a public issue for them.
