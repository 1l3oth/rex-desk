// Runs Settings › Storage's counting off the desk's thread (see src/storage-scan.js). One message in, one answer out.
import { parentPort } from 'node:worker_threads';
import * as scan from './storage-scan.js';

const ops = {
  summary: ({ scope, now, findDuplicates }) => Promise.all([scan.usage(scope), scan.suggestions(scope, now, { findDuplicates })]).then(([usage, suggestions]) => ({ usage, suggestions })),
  usage: ({ scope }) => scan.usage(scope),
  duplicates: ({ scope }) => scan.duplicates(scope),
  list: ({ scope, place, folder }) => scan.list(scope, place, folder),
  search: ({ scope, query }) => scan.search(scope, query),
  oldMedia: ({ scope, now }) => scan.oldMedia(scope, now),
  oldBackups: ({ scope, now }) => scan.oldBackups(scope, now),
  oldCopies: ({ scope }) => scan.oldCopies(scope),
};

parentPort.on('message', async ({ id, op, args }) => {
  try { parentPort.postMessage({ id, result: await ops[op](args) }); }
  catch (error) { parentPort.postMessage({ id, error: error?.message || String(error) }); }
});
