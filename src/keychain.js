import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// The macOS login Keychain, reached through Apple's own `security` tool, so "stay signed in" works on a Mac the way DPAPI
// makes it work on Windows: the key is kept where only this Mac user (and the tool that stored it) can read it, and no
// prompt appears because the tool that made the item is the one that reads it back.
const run = promisify(execFile);
const SECURITY = '/usr/bin/security';
const SERVICE = 'Rex Desk';
const NOT_FOUND = 44; // errSecItemNotFound: the item is gone (a reset or cleaned Keychain), so there is nothing to wait for

export function createKeychain({ exec = (command, args) => run(command, args, { timeout: 20000 }) } = {}) {
  const account = id => `vault-key:${id}`;
  // A missing item is marked, so the caller can tell "forget it" from "locked or busy: try again later".
  const failed = error => Object.assign(error, { missing: error?.code === NOT_FOUND });
  return {
    async set(id, data) {
      try { await exec(SECURITY, ['add-generic-password', '-a', account(id), '-s', SERVICE, '-l', 'Rex Desk stay signed in', '-w', Buffer.from(data).toString('base64'), '-U']); }
      catch (error) { throw failed(error); }
    },
    async get(id) {
      try { const { stdout } = await exec(SECURITY, ['find-generic-password', '-a', account(id), '-s', SERVICE, '-w']); return Buffer.from(String(stdout).trim(), 'base64'); }
      catch (error) { throw failed(error); }
    },
    async remove(id) {
      try { await exec(SECURITY, ['delete-generic-password', '-a', account(id), '-s', SERVICE]); }
      catch (error) { if (error?.code !== NOT_FOUND) throw failed(error); }
    },
  };
}
