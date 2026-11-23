// Scheduled messages: the person sets up a message for one agent, once or on repeat ("every weekday at 9:00: check Orbit"),
// and Rex Desk sends it into that agent's personal chat at that time, as if the person typed it.
import { randomUUID } from 'node:crypto';
import { inHours } from './specialists.js';

export const REPEATS = ['once', 'daily', 'weekdays', 'weekly'];
const clock = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? String(value) : '';

// The next time a schedule is due after `from`: on its time of day, on a day its repeat allows.
export function nextRun({ time, repeat = 'once', day = null, date = '' }, from = new Date()) {
  const [hour, minute] = time.split(':').map(Number);
  if (repeat === 'once') {
    const at = date ? new Date(`${date}T${time}:00`) : new Date(from);
    if (!date) { at.setHours(hour, minute, 0, 0); if (at <= from) at.setDate(at.getDate() + 1); }
    return at;
  }
  for (let step = 0; step < 8; step++) {
    const at = new Date(from); at.setDate(at.getDate() + step); at.setHours(hour, minute, 0, 0);
    if (at <= from) continue;
    const weekday = at.getDay();
    if (repeat === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (repeat === 'weekly' && weekday !== Number(day ?? weekday)) continue;
    return at;
  }
  return null;
}

export class Schedules {
  constructor(store, desk) { this.store = store; this.desk = desk; }
  list(agentId = '') { return this.store.list('schedmsg').filter(item => !agentId || item.agentId === agentId).sort((left, right) => String(left.nextAt).localeCompare(String(right.nextAt))); }
  create(agentId, { text, time, repeat = 'once', date = '', day = null } = {}, from = new Date()) {
    if (agentId === 'main') this.desk.specialists.ensureMain(); this.desk.specialists.get(agentId);
    const body = String(text || '').trim().slice(0, 4000);
    if (!body) throw new Error('Write the message to send.');
    if (!clock(time)) throw new Error('Pick a time, like 09:00.');
    if (!REPEATS.includes(repeat)) throw new Error('Pick how often: once, every day, weekdays or once a week.');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick a date.');
    const item = { id: randomUUID(), agentId, text: body, time, repeat, date: repeat === 'once' ? date : '', day: repeat === 'weekly' ? Number(day ?? from.getDay()) : null, on: true, createdAt: from.toISOString() };
    const next = nextRun(item, from);
    if (!next || next <= from) throw new Error('That time has already passed.');
    const saved = { ...item, nextAt: next.toISOString() };
    this.store.put('schedmsg', saved.id, saved); return saved;
  }
  remove(id) { if (!this.store.get('schedmsg', id)) throw new Error('That scheduled message is gone.'); this.store.delete('schedmsg', id); return { removed: true }; }
  toggle(id, on) {
    const item = this.store.get('schedmsg', id); if (!item) throw new Error('That scheduled message is gone.');
    const next = on ? nextRun(item, new Date()) : null;
    const updated = { ...item, on: Boolean(on) && Boolean(next), ...(next ? { nextAt: next.toISOString() } : {}) };
    this.store.put('schedmsg', id, updated); return updated;
  }
  // Called by the server's timer. A message that came due while the computer was off is sent once, not once per missed day.
  async tick(at = new Date()) {
    // Only the computer the agent works on sends it, so two computers never send the same message twice.
    for (const item of this.list().filter(entry => entry.on && entry.nextAt && Date.parse(entry.nextAt) <= at.getTime() && (entry.agentId === 'main' || this.desk.peers?.owns?.(entry.agentId) !== false))) {
      // Work hours are the agent's whole shift: a message due off-shift waits, and is sent once the shift is back.
      const hours = this.store.get('specialist', item.agentId)?.loop?.hours;
      if (hours?.on && !inHours(hours, at)) continue;
      const next = item.repeat === 'once' ? null : nextRun(item, at);
      this.store.put('schedmsg', item.id, { ...item, lastAt: at.toISOString(), on: Boolean(next), nextAt: next ? next.toISOString() : item.nextAt });
      if (!this.store.get('specialist', item.agentId) && item.agentId !== 'main') { this.store.delete('schedmsg', item.id); continue; }
      try { await this.desk.specialistTurn(item.agentId, { prompt: `Scheduled message from the person (set for ${item.time}):\n${item.text}` }); }
      catch (error) { this.store.put('schedmsg', item.id, { ...this.store.get('schedmsg', item.id), error: String(error.message || error).slice(0, 300) }); }
    }
  }
}
