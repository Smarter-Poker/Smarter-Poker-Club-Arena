import { createHash } from 'node:crypto';
import { offenders } from './check-money-trigger-declared.mjs';
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const requireThat = (v, message) => { if (!v) throw new Error(message); };
// policy is loaded exclusively from reviewed default-branch code, NEVER PR files.
// live is obtained directly by that trusted job, NEVER from a PR artifact.
export function verifyRecovery({ path, sql, policy, live, headSha, files, now = Date.now() }) {
  requireThat(/^[a-f0-9]{40}$/.test(headSha), 'invalid PR head');
  const hits = offenders(sql);
  if (!hits.length) return { path, sha256: sha256(sql), recovered: false };
  requireThat(live?.version === 1 && Number.isFinite(Date.parse(live.observed_at)) && Math.abs(now - Date.parse(live.observed_at)) < 300000, 'missing or stale live proof');
  const rows = policy.filter((p) => p.path === path);
  requireThat(rows.length === 1, 'no unique independently reviewed recovery contract');
  const p = rows[0];
  requireThat(typeof p.review === 'string' && p.review.length > 10 && p.originalSha256 === sha256(sql), 'changed historical SQL or missing review');
  requireThat(/^\d{14}$/.test(p.originalVersion) && /^\d{14}$/.test(p.declarationVersion), 'invalid reviewed versions');
  requireThat(path === `supabase/migrations/${p.originalVersion}_${p.originalName}.sql`, 'original path differs');
  const recordPath = `supabase/migrations/${p.declarationVersion}_${p.declarationName}.sql`;
  requireThat(files?.[recordPath] !== undefined && sha256(files[recordPath]) === p.declarationSha256, 'exact declaration record missing from candidate');
  const original = live.history.filter((h) => h.version === p.originalVersion);
  const declaration = live.history.filter((h) => h.version === p.declarationVersion);
  requireThat(original.length === 1 && original[0].name === p.originalName && original[0].statementCount === 1 && original[0].sha256 === p.originalSha256, 'original history differs');
  requireThat(declaration.length === 1 && declaration[0].name === p.declarationName && declaration[0].statementCount === 1 && declaration[0].sha256 === p.declarationSha256, 'declaration not applied exactly');
  const key = (x) => `${x.table}.${x.trigger}`;
  requireThat(p.triggers.length === hits.length && new Set(p.triggers.map(key)).size === hits.length && hits.every((x) => p.triggers.some((t) => key(t) === key(x))), 'uncovered or duplicate trigger');
  for (const t of p.triggers) {
    const actual = live.triggers.filter((x) => key(x) === key(t));
    const reg = live.declarations.filter((x) => key(x) === key(t));
    requireThat(actual.length === 1 && actual[0].enabled === 'O' && actual[0].definitionSha256 === t.definitionSha256 && actual[0].functionSha256 === t.functionSha256, 'trigger authority differs');
    requireThat(reg.length === 1 && reg[0].note === t.note && t.note.length >= 40, 'registry declaration differs');
  }
  return { path, sha256: p.originalSha256, recovered: true, headSha, declarationVersion: p.declarationVersion };
}
