import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { now } from './store.js';

const exec = promisify(execFile);
// Each account's vault key (which encrypts its API keys and tokens) is sealed with a key derived from the person's
// passphrase. Rex Desk keeps only the sealed copy, so a workspace opens only for someone who knows its passphrase.
const kdfDefaults = { name: 'scrypt', N: 32768, r: 8, p: 1 };
const deriveKey = (passphrase, kdf) => scryptSync(String(passphrase).normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024 });

export function sealKey(vaultKey, passphrase) {
  const kdf = { ...kdfDefaults, salt: randomBytes(16).toString('base64') }, nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, kdf), nonce);
  const sealed = Buffer.concat([cipher.update(vaultKey), cipher.final()]);
  return { kdf, sealedKey: Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString('base64') };
}

export function openKey({ kdf, sealedKey }, passphrase) {
  const data = Buffer.from(sealedKey, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, kdf), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  try { return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]); }
  catch { throw new Error('Email or passphrase is incorrect.'); }
}

export function checkPassphrase(passphrase) {
  if (String(passphrase || '').length < 8) throw new Error('Use a passphrase of at least 8 characters.');
}
export function cleanEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 200) throw new Error('Enter a valid email address.');
  return value;
}

// "Stay signed in" keeps the vault key protected by Windows for this Windows user only (DPAPI), so a restart can reopen it.
async function protectForUser(data, unprotect = false) {
  if (process.platform !== 'win32') throw new Error('Staying signed in is available on Windows.');
  const method = unprotect ? 'Unprotect' : 'Protect';
  const script = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}([Convert]::FromBase64String($env:REX_DATA), $null, 'CurrentUser'))`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, env: { ...process.env, REX_DATA: data.toString('base64') } });
  return Buffer.from(stdout.trim(), 'base64');
}

export class Accounts {
  constructor(root) {
    this.root = path.resolve(root); this.file = path.join(this.root, 'accounts.json');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    this.superadmins = (saved.superadmins || []).map(email => String(email).toLowerCase());
    this.workspaces = saved.workspaces || this.legacy();
  }
  // A data folder from before accounts becomes the first account; its owner claims it with an email and passphrase.
  legacy() {
    if (!existsSync(path.join(this.root, 'desk.sqlite'))) return [];
    const idFile = path.join(this.root, 'workspace.id');
    return [{ id: existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : randomUUID(), email: '', dir: '.', createdAt: now() }];
  }
  save() {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ superadmins: this.superadmins, workspaces: this.workspaces }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  role(email) { return this.superadmins.includes(String(email || '').toLowerCase()) ? 'superadmin' : 'member'; }
  summary() {
    return this.workspaces.map(({ id, email, kdf, createdAt, lastUsedAt, remembered }) => ({ id, email, claimed: Boolean(kdf), role: this.role(email), staySignedIn: Boolean(remembered), createdAt, lastUsedAt }))
      .sort((left, right) => String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || '')));
  }
  find(id) { const entry = this.workspaces.find(item => item.id === id); if (!entry) throw new Error('Account not found.'); return entry; }
  byEmail(email) { return this.workspaces.find(item => item.email === email); }
  directory(entry) { return path.resolve(this.root, entry.dir); }
  // The first account on an installation without superadmins becomes its superadmin.
  claimAdmin(email) { if (!this.superadmins.length) { this.superadmins.push(email); this.save(); } }
  create(email, passphrase, { id = randomUUID(), sealed } = {}) {
    const address = cleanEmail(email);
    if (this.byEmail(address)) throw new Error('An account with that email already exists on this computer. Sign in instead.');
    if (!sealed) checkPassphrase(passphrase);
    const vaultKey = sealed ? openKey(sealed, passphrase) : randomBytes(32);
    const entry = { id, email: address, dir: path.join('workspaces', id), createdAt: now(), ...(sealed || sealKey(vaultKey, passphrase)) };
    const directory = this.directory(entry);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, 'workspace.id'), id, { mode: 0o600 });
    this.workspaces.push(entry); this.claimAdmin(address); this.save();
    return { entry, vaultKey };
  }
  // Sign in by email. The unclaimed legacy workspace is sealed with the first email and passphrase used on it.
  async signIn(email, passphrase, { claimId } = {}) {
    const address = cleanEmail(email);
    const entry = this.byEmail(address);
    if (entry) return { entry, vaultKey: openKey(entry, passphrase) };
    const legacy = claimId && this.workspaces.find(item => item.id === claimId && !item.kdf);
    if (!legacy) throw new Error('Email or passphrase is incorrect.');
    checkPassphrase(passphrase);
    const keyFile = path.join(this.directory(legacy), 'vault.key');
    if (!existsSync(keyFile)) throw new Error('This workspace has no key file. Restore it from cloud backup instead.');
    const vaultKey = readFileSync(keyFile);
    Object.assign(legacy, { email: address }, sealKey(vaultKey, passphrase)); this.claimAdmin(address); this.save(); unlinkSync(keyFile);
    return { entry: legacy, vaultKey };
  }
  touch(id) { const entry = this.find(id); entry.lastUsedAt = now(); this.save(); return entry; }
  async remember(id, vaultKey) { const entry = this.find(id); entry.remembered = (await protectForUser(vaultKey)).toString('base64'); this.save(); }
  forget(id) { const entry = this.workspaces.find(item => item.id === id); if (entry?.remembered) { delete entry.remembered; this.save(); } }
  // At startup, reopen the most recent account that chose to stay signed in on this computer.
  async rememberedSession() {
    const entry = this.workspaces.filter(item => item.remembered).sort((left, right) => String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || '')))[0];
    if (!entry) return null;
    try { return { entry, vaultKey: await protectForUser(Buffer.from(entry.remembered, 'base64'), true) }; }
    catch { this.forget(entry.id); return null; }
  }
}
