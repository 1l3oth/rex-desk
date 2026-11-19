// An agent whose chat went two ways on two computers (from before chats were shared): the person picks the one to keep.
// See docs/design/cross-device-chat.md. The record `chatsplit/<agent id>` is shared, so every computer shows the same
// question; each computer adds its own side (how many messages, the last one) and acts on the answer for its own copy.
import { now } from './store.js';

export class ChatSplits {
  constructor(desk) { this.desk = desk; this.store = desk.store; }
  get self() { return this.desk.peers.self.id; }
  // Messages of this chat written here that the computer running the agent never got: this computer's own story.
  ownUnshared(agent) {
    return this.store.db.prepare("SELECT sequence, kind, value, created_at FROM events WHERE run_id=? AND pushed IS NULL AND visible=1 AND uid LIKE ? || '.%' ORDER BY sequence")
      .all(agent.runId, this.self);
  }
  side(rows, node) {
    const said = rows.filter(row => ['human-message', 'agent-text'].includes(row.kind));
    const last = said.at(-1);
    let text = ''; try { text = String(JSON.parse(last?.value || '{}').text || '').replace(/\s+/g, ' ').slice(0, 160); } catch { text = ''; }
    return { node, name: this.desk.peers.deviceName(node), messages: said.length, lastAt: last?.created_at || '', lastText: text };
  }
  // Run on every computer once a minute. A computer that is not running the agent but holds its own messages of the
  // agent's chat that never went anywhere opens the question.
  detect() {
    const opened = [];
    if (!this.store.cloud?.ready) return opened;
    for (const agent of this.store.list('specialist')) {
      if (agent.kind === 'main' || agent.id === 'main' || !agent.runId || !agent.node || agent.noCloud) continue;
      const split = this.store.get('chatsplit', agent.id);
      if (split && !split.open) continue;
      if (agent.node === this.self) {
        // The computer running the agent adds its side to a question another computer opened.
        if (split?.open && !split.sides?.some(item => item.node === this.self)) {
          const rows = this.store.db.prepare("SELECT kind, value, created_at FROM events WHERE run_id=? AND visible=1 AND uid LIKE ? || '.%' ORDER BY sequence").all(agent.runId, this.self);
          this.store.put('chatsplit', agent.id, { ...split, sides: [...split.sides, this.side(rows, this.self)] });
        }
        continue;
      }
      const mine = this.ownUnshared(agent);
      if (!mine.some(row => row.kind === 'human-message')) continue;
      if (split?.sides?.some(item => item.node === this.self)) continue;
      const sides = [...(split?.sides || []), this.side(mine, this.self)];
      this.store.put('chatsplit', agent.id, { id: agent.id, agentId: agent.id, runId: agent.runId, open: true, sides, at: split?.at || now() });
      opened.push(agent.id);
    }
    return opened;
  }
  // The person picked the chat to keep (the computer it is on). Every computer then puts the other side away.
  pick(agentId, node) {
    const split = this.store.get('chatsplit', agentId), agent = this.store.get('specialist', agentId);
    if (!split?.open || !agent) throw new Error('This agent has only one chat.');
    if (!split.sides.some(item => item.node === node)) throw new Error('Pick one of the chats shown.');
    this.store.put('chatsplit', agentId, { ...split, open: false, kept: node, pickedAt: now() });
    // The kept chat's computer runs the agent from now on, so its story goes on.
    if (agent.node !== node) this.store.put('specialist', agentId, { ...agent, node, movedAt: now(), movedFrom: agent.node });
    this.settle(agentId);
    return this.store.get('chatsplit', agentId);
  }
  // On each computer, once the answer is in: the messages of the chat that was not kept move to an archive copy that is
  // never shared, and the kept one is sent (if it is here) so every computer ends up with it.
  settle(agentId) {
    const split = this.store.get('chatsplit', agentId), agent = this.store.get('specialist', agentId);
    if (!split || split.open || !agent || (split.settled || []).includes(this.self)) return false;
    const runId = split.runId || agent.runId, archive = `${runId}~${this.self.slice(0, 8)}`;
    this.store.transaction(() => {
      const keepMine = split.kept === this.self;
      // Put away what does not belong to the kept chat: here, every message that did not come from the kept computer.
      const rows = this.store.db.prepare('SELECT * FROM events WHERE run_id=?').all(runId)
        .filter(row => keepMine ? !String(row.uid || '').startsWith(`${this.self}.`) : String(row.uid || '').startsWith(`${this.self}.`));
      const copy = this.store.db.prepare('INSERT OR IGNORE INTO events(run_id,kind,visible,value,created_at,uid) VALUES(?,?,?,?,?,?)');
      const remove = this.store.db.prepare('DELETE FROM events WHERE sequence=?');
      for (const row of rows) { copy.run(archive, row.kind, row.visible, row.value, row.created_at, `${row.uid}~archived`); remove.run(row.sequence); }
      // What was put away is taken out of the shared chat for every computer too. Keeping this computer's chat, its own
      // messages go out with the next push (pushChats) now that the question is closed.
      for (const row of rows) if (row.uid) this.store.cloud?.removeChatEvent?.(row.uid, runId);
    });
    this.store.put('chatsplit', agentId, { ...this.store.get('chatsplit', agentId), settled: [...(split.settled || []), this.self] });
    this.store.emit('change', { kind: 'event', runId });
    return true;
  }
  settleAll() { for (const split of this.store.list('chatsplit')) if (!split.open) this.settle(split.agentId || split.id); }
  open() { return this.store.list('chatsplit').filter(split => split.open); }
}
