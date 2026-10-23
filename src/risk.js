import { git } from './processes.js';

export async function assessRisk(run, assessment, currentFingerprint) {
  if (assessment && (!Number.isInteger(assessment.score) || assessment.score < 1 || assessment.score > 10
    || typeof assessment.requiresHumanReview !== 'boolean' || !String(assessment.reason || '').trim())) {
    throw new Error('Risk assessment needs score 1–10, requiresHumanReview, and a concrete reason.');
  }
  const files = (await git(run.worktree, ['diff', '--no-renames', '--name-only', '-z', run.baseCommit || 'HEAD'])).split('\0').filter(Boolean);
  const stats = (await git(run.worktree, ['diff', '--no-renames', '--numstat', '-z', run.baseCommit || 'HEAD'])).split('\0').filter(Boolean);
  let changedLines = 0, binary = false;
  for (const stat of stats) { const [added, removed] = stat.split('\t'); if (added === '-' || removed === '-') binary = true; else changedLines += Number(added) + Number(removed); }
  const reasons = [];
  let floor = 1;
  const raise = (score, reason) => { floor = Math.max(floor, score); reasons.push(reason); };
  if (!files.length) raise(5, 'No committed change footprint was found.');
  if (files.some(file => /(^|\/)([^/]*(?:auth|oauth|permission|session|token|billing|payment|migration|database|deploy|secret|credential)[^/]*|\.github|jex\/config)(\/|\.|$)/i.test(file)
    || /\.(sql|ya?ml|properties|xml)$/i.test(file) || /(^|\/)(package(-lock)?\.json|[^/]*lockfile|Dockerfile|server\.[^/]+)$/i.test(file))) {
    raise(7, 'Security, data, dependencies, deployment, or server configuration changed.');
  }
  if (binary) raise(7, 'Binary or compiled output changed and needs human inspection.');
  if (files.length > 10 || changedLines > 300) raise(6, 'The change spans more than 10 files or 300 added/removed lines.');
  else if (files.length > 3 || changedLines > 80) raise(4, 'The change exceeds the small-fix limit of 3 files and 80 added/removed lines.');
  const narrowSurface = files.every(file => /\.(css|scss|sass|less|html|svg|md|txt)$/i.test(file) || /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file));
  if (!narrowSurface) raise(4, 'Executable application code changed; human review is required before a draft PR.');
  if (!assessment) raise(10, 'Agent did not submit a self-review. Ask it to report risk before relying on the result.');
  const score = Math.max(floor, assessment?.score || 10);
  return { score, level: score <= 2 ? 'Low' : score <= 5 ? 'Medium' : 'High', agentScore: assessment?.score ?? null, floor,
    requiresHumanReview: !assessment || assessment.requiresHumanReview || score > 2,
    reason: String(assessment?.reason || 'No agent self-review provided.'), factors: (assessment?.factors || []).map(String).slice(0, 20),
    safeguards: reasons, files, changedLines, fingerprint: currentFingerprint, assessedAt: new Date().toISOString() };
}
export function automaticPrAllowed(config, run, currentFingerprint) {
  return Boolean(config.autoPrLowRisk && run.state === 'ready_for_review' && run.checks?.testsPassed
    && (!config.requireVideo || run.checks.recordedVideo && run.checks.browserAssertionPassed)
    && run.risk?.score <= 2 && !run.risk.requiresHumanReview && run.risk.fingerprint === currentFingerprint
    && run.verification?.fingerprint === currentFingerprint);
}
