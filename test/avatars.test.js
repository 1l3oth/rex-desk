import test from 'node:test';
import assert from 'node:assert/strict';
import { Specialists } from '../src/specialists.js';
import { AVATARS } from '../public/avatars.js';

// The parts of Specialists that pick and check avatars, over a plain list of agents.
const withAgents = agents => {
  const store = new Map(agents.map(agent => [agent.id, agent]));
  return Object.assign(Object.create(Specialists.prototype), { list: () => [...store.values()], store: { get: (kind, id) => store.get(id), put: (kind, id, value) => store.set(id, value) }, saved: store });
};

test('every agent gets its own avatar; one the person picks or uploads is checked', () => {
  assert.equal(AVATARS.length, Specialists.AVATARS);
  assert.equal(new Set(AVATARS).size, AVATARS.length, 'no two pictures are the same');
  assert.ok(AVATARS.every(svg => svg.startsWith('<svg') && svg.length < 4000), 'each picture is a small SVG');
  const agents = withAgents([{ id: 'a', avatar: 'a:0', createdAt: '1' }, { id: 'b', createdAt: '2' }, { id: 'c', createdAt: '3' }, { id: 'remote', node: 'other-pc', createdAt: '0' }]);
  agents.ensureAvatars('this-pc');
  assert.equal(agents.saved.get('b').avatar, 'a:1'); assert.equal(agents.saved.get('c').avatar, 'a:2');
  assert.equal(agents.saved.get('remote').avatar, undefined, 'another computer gives its own agents theirs');
  assert.equal(agents.nextAvatar(), 'a:3');
  assert.equal(agents.cleanAvatar('a:127'), 'a:127');
  assert.equal(agents.cleanAvatar('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
  assert.throws(() => agents.cleanAvatar('a:999'), /Pick one of the avatars/);
  assert.throws(() => agents.cleanAvatar('javascript:alert(1)'), /Pick one of the avatars/);
  assert.throws(() => agents.cleanAvatar(`data:image/png;base64,${'A'.repeat(90000)}`), /under 60 KB/);
});
