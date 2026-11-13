// Choosing an agent's avatar: one of the 128 pictures, or a picture of the person's own, shrunk to 128 x 128 here in the
// browser so it stays small (it travels with the agent to the person's other computers).
import { AVATARS } from '/avatars.js';
import { agentPicture } from '/chat-rooms.js';

const shrink = file => new Promise((resolve, reject) => {
  if (!/^image\//.test(file.type)) return reject(new Error('Pick a picture file (PNG, JPEG, WebP or GIF).'));
  const image = new Image(), url = URL.createObjectURL(file);
  image.onload = () => {
    const size = 128, canvas = Object.assign(document.createElement('canvas'), { width: size, height: size }), context = canvas.getContext('2d');
    // Cover the square from the middle of the picture, like a profile photo.
    const side = Math.min(image.naturalWidth, image.naturalHeight), x = (image.naturalWidth - side) / 2, y = (image.naturalHeight - side) / 2;
    context.drawImage(image, x, y, side, side, 0, 0, size, size); URL.revokeObjectURL(url);
    const webp = canvas.toDataURL('image/webp', 0.86);
    resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png'));
  };
  image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That picture could not be read.')); };
  image.src = url;
});

export function openAvatarPicker(ctx, agent) {
  const { api, esc, toast, refresh } = ctx;
  document.querySelector('.dialog-back.avatar-pick')?.remove();
  const back = document.createElement('div'); back.className = 'dialog-back avatar-pick';
  const current = String(agent.avatar || '');
  back.innerHTML = `<div class="dialog ap-dialog" role="dialog" aria-modal="true" aria-labelledby="ap-title">
    <div class="ap-head"><img class="ap-now" src="${esc(agentPicture(agent))}" alt=""><div><h2 id="ap-title">${esc(agent.name)}'s avatar</h2><p class="muted">Pick one, or use a picture of your own.</p></div>
      <button type="button" class="icon-btn ap-close" data-ap-close aria-label="Close"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="ap-grid" role="listbox" aria-label="Avatars">${AVATARS.map((svg, index) => `<button type="button" role="option" class="ap-item${current === `a:${index}` ? ' on' : ''}" aria-selected="${current === `a:${index}`}" data-ap-pick="a:${index}" aria-label="Avatar ${index + 1}"><img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" alt="" loading="lazy"></button>`).join('')}</div>
    <div class="ap-foot"><label class="btn"><input type="file" accept="image/*" data-ap-upload hidden>Upload a picture</label><span class="muted">Shrunk to 128 × 128 pixels.</span></div></div>`;
  document.body.append(back);
  const close = () => back.remove();
  const save = async avatar => {
    try { await api(`/specialists/${encodeURIComponent(agent.id)}`, { method: 'PUT', data: { avatar } }); close(); toast(`${agent.name} has a new avatar.`); await refresh(); }
    catch (error) { toast(error.message, true); }
  };
  back.addEventListener('click', event => {
    if (event.target === back || event.target.closest('[data-ap-close]')) return close();
    const pick = event.target.closest('[data-ap-pick]'); if (pick) void save(pick.dataset.apPick);
  });
  back.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  back.querySelector('[data-ap-upload]').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try { await save(await shrink(file)); } catch (error) { toast(error.message, true); }
  });
  back.querySelector('.ap-item.on, .ap-item')?.focus();
}
