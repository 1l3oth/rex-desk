import { createCipheriv, createDecipheriv, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, constants } from 'node:crypto';

// A file to fill in, answered on another of the person's computers. The computer the agent works on makes a one-time lock
// for each request and keeps the only key that opens it in memory. What the person types elsewhere is locked with it before
// it leaves that computer, so the cloud database only ever carries scrambled text, and only this computer can open it.
export function makeLock() {
  return generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
}
const OAEP = key => ({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' });
export function seal(publicKey, values) {
  const secret = randomBytes(32), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  return { key: publicEncrypt(OAEP(publicKey), secret).toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function unseal(privateKey, sealed = {}) {
  const secret = privateDecrypt(OAEP(privateKey), Buffer.from(String(sealed.key || ''), 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(String(sealed.nonce || ''), 'base64'));
  decipher.setAuthTag(Buffer.from(String(sealed.tag || ''), 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(String(sealed.data || ''), 'base64')), decipher.final()]).toString('utf8'));
}
// Sets KEY=value lines in an .env text: a key already there gets the new value in place, a new key is added at the end.
export function setEnvValues(content, values = {}) {
  const lines = String(content || '').split('\n'), done = new Set();
  const quoted = value => /[\s#"'=]/.test(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][\w.-]*)(\s*=\s*)(.*)$/.exec(lines[index]);
    if (match && Object.hasOwn(values, match[2]) && !done.has(match[2])) { lines[index] = `${match[1]}${match[2]}${match[3]}${quoted(String(values[match[2]]))}`; done.add(match[2]); }
  }
  const added = Object.entries(values).filter(([key]) => !done.has(key)).map(([key, value]) => `${key}=${quoted(String(value))}`);
  let text = lines.join('\n');
  if (added.length) text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${added.join('\n')}\n`;
  return text;
}
