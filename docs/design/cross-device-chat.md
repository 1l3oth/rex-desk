# One account, one chat per agent, on every computer

Spec (Rex, 2026-11-19, and the rex-desk-site "Start at home. Finish at work." section):

- One account has one database. Every computer keeps a full local copy; the cloud (Turso, paid plan) is the hub.
- A new computer pulls everything at its first sign-in; afterwards changes sync live (about 1 s while an agent works).
- One agent has exactly one chat, the same on every computer. Any computer can watch it and send to it.
- Only one computer runs an agent at a time (the agent card's `node`). Follow me on: a message from another computer
  stops it there and continues the same chat here. Follow me off (or the project runs only on its computer): it stays,
  messages reach it through the cloud.
- An agent that already has different chats on different computers is flagged; the person picks the one to keep.
- Rex Agent (the main agent) is per computer: its chats are never uploaded.
- Every computer has an id and a name; each shows online or offline correctly everywhere.

## What was wrong (2026-11-19)

1. `events.sequence` is a local autoincrement. The cloud backup `rex_events` is keyed by `(workspace, sequence)` and
   `TursoSync.pullLatest` copies it back with `INSERT OR REPLACE ... sequence` and deletes local rows it does not know.
   Two computers in one workspace overwrite each other's messages.
2. `pullLatest` also copies `rex_records` into `records` directly. A `peercmd` that arrived that way never ran:
   `runCommand` is triggered only by `Peers.applyAll`, and the later pull sees the same `_v` and reports no change.
3. Chats crossed computers only as `chatcopy` snapshots (newest 160 messages); each computer kept its own runs.

## Design

### Message identity

Every event row gets `uid` = `<node id>.<local sequence>` at insert, unique and never changed. Rows from another
computer keep their uid. A unique index on `events(uid)` makes every import idempotent.

### Chat sync (`rex_chat`)

Cloud table `rex_chat(workspace, uid, run_id, kind, visible, value, created_at, v, node, deleted)`,
primary key `(workspace, uid)`, index `(workspace, v)`. `v` is the store stamp (time.clock.node), as in `rex_shared`.

- A **synced chat** is the run of a non-main agent (`run.role === 'specialist'`, its `specialistId` card exists and is
  not `main`), not kept out of the cloud (`noCloud`), with chats backup on.
- Push: `Peers.pushChats()` uploads, per synced chat, every local event with a uid made here and a sequence above the
  chat's watermark (`chatpush` meta). Uploading is an upsert by uid, so a retry never duplicates.
- Pull: `Peers.pullChats()` reads rows with `v` above the cursor (minus a 2-minute overlap for clocks), not written by
  this node, and `INSERT OR IGNORE`s them by uid. A `deleted` row (unsend) removes the local row with that uid.
- Both run in the peers loop: every second while something is in flight, every 5 s otherwise.

`rex_events` stays as this computer's own backup; `pullLatest` no longer replaces or deletes local events (the chat
sync carries other computers' messages).

### Commands

`runCommand` also runs from `pendingCommands()` on every loop tick (cheap: the list is cached) and after `pullLatest`,
so a command is never lost to the path it arrived by. A chat message older than a day is not delivered late; it is
closed with an error the chat shows.

### Sending from a computer that is not running the agent

The message is written to the local chat at once (so it shows instantly and syncs with its own uid), and the
`chat-say` command carries that uid. The running computer passes it to the agent without writing a second copy.

### Following

Unchanged in shape: `ProjectRules.move` takes the agent card (`node = here`). The chat is already here in full, so
nothing is copied. The computer that ran it sees its card point elsewhere and stops its idle session.

### Split chats

After the first full pull, for each non-main agent, the candidate chats are its card's `runId` plus local specialist
runs of that agent with a human message whose events are not in the card's chat. More than one candidate with
messages: a shared `chatsplit` record lists them (computer, last message, count). The agent shows "Pick a chat";
picking sets the card's `runId` and archives the others. Until then that agent's chat is not pushed.

### Computers

`rex_presence` heartbeat every 30 s; online = heard within 90 s by this computer's clock. Closing Rex Desk writes
`at = 0`, so it shows offline at once. A computer without a name is asked for one. One API (`/api/devices`) and one
UI helper render name, dot and "last seen" everywhere a computer appears.
