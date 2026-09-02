#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CREDENTIAL THAT EXPIRES SILENTLY IS AN OUTAGE WITH A DATE ON IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2026-09-01. The estate learned GH_PAT's expiry (2026-11-19) from a comment
 * and a THIRD token's supposed expiry (2026-11-10) from a stale worktree doc
 * that turned out to describe a superseded token. Nothing anywhere watches
 * these dates, so the first warning of a lapse would be the day automation or
 * a human's git stopped working.
 *
 * This reads scripts/ci/secrets-inventory.json - names and expiry dates, never
 * values - and:
 *   - LIVE-CHECKS what can be checked: a GitHub token's real expiry via the
 *     API header, and a Supabase key's format (sb_secret_/sb_publishable_ =
 *     non-expiring; a legacy eyJ JWT gets its exp decoded). Live truth
 *     overrides the file, and a drift between them is itself reported.
 *   - ALARMS on anything expiring within warn_days.
 *   - FLAGS every row whose expiry is "unknown" so a human fills it in - an
 *     unknown expiry is not a passed check.
 *
 * It NEVER prints a secret value (it only ever sees the GH token it is handed,
 * and reports its DATE, not the token). It opens ONE self-updating issue.
 *
 * Usage:  node scripts/ci/check-secrets-expiry.mjs
 * Exit:   always 0 (an alarm is an issue, not a failed job - a red daily job
 *         becomes wallpaper, and this runs weekly)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_DIR = process.cwd();
const REPO = process.env.REPO || 'Smarter-Poker/Smarter-Poker-Club-Arena';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
// Issues are written with GITHUB_TOKEN when available: the live expiry read
// needs the PAT (the App token has no expiry header), but the PAT is itself a
// thing we watch, so the alarm must not depend on it being alive.
const ISSUE_TOKEN = process.env.GH_TOKEN_ISSUES || process.env.GITHUB_TOKEN || TOKEN;
const INVENTORY = join(REPO_DIR, 'scripts/ci/secrets-inventory.json');
const DAY = 86400_000;

const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
const warnDays = Number(inv.warn_days || 21);
const now = Date.now();
const findings = []; // {level, name, msg}

// ── live check: the GitHub token's own expiry, straight from the API ────────
async function githubTokenExpiry() {
  if (!TOKEN) return null;
  const res = await fetch('https://api.github.com/rate_limit', {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' },
  });
  const hdr = res.headers.get('github-authentication-token-expiration');
  return hdr ? hdr.slice(0, 10) : null; // 'YYYY-MM-DD ...' or null (App/no-expiry)
}

// ── live check: a Supabase key's format tells you if it expires at all ──────
function supabaseKeyStatus(sampleEnvName) {
  const v = process.env[sampleEnvName] || '';
  if (!v) return { known: false };
  if (v.startsWith('sb_secret_') || v.startsWith('sb_publishable_'))
    return { known: true, expires: null }; // new format, non-expiring
  if (v.startsWith('eyJ')) {
    try {
      // base64url payload; Buffer accepts base64url and handles padding.
      const json = JSON.parse(Buffer.from(v.split('.')[1], 'base64url').toString('utf8'));
      return { known: true, expires: json.exp ? new Date(json.exp * 1000).toISOString().slice(0, 10) : null };
    } catch {
      return { known: false };
    }
  }
  return { known: false };
}

const daysUntil = (dateStr) => Math.round((Date.parse(dateStr + 'T00:00:00Z') - now) / DAY);

const ghExpiry = await githubTokenExpiry().catch(() => null);

for (const s of inv.secrets) {
  // Resolve the effective expiry: live check wins where available.
  let expires = s.expires;
  let source = 'inventory';

  if (s.live_check === 'github_token_expiry' && ghExpiry) {
    if (s.expires && s.expires !== ghExpiry) {
      findings.push({
        level: 'notice',
        name: s.name,
        msg: `inventory says ${s.expires} but the live GitHub token expires ${ghExpiry} - update the inventory row.`,
      });
    }
    expires = ghExpiry;
    source = 'live GitHub API';
  }
  if (s.live_check === 'supabase_key_format') {
    const envName = s.name.split(' ')[0]; // e.g. SUPABASE_SERVICE_ROLE_KEY
    const st = supabaseKeyStatus(envName);
    if (st.known) {
      expires = st.expires;
      source = 'live key format';
    }
  }

  if (expires === null || expires === undefined) continue; // non-expiring, fine
  if (expires === 'unknown') {
    findings.push({
      level: 'unknown',
      name: s.name,
      msg: `expiry is UNKNOWN (${s.where}). Verify it and set the date in secrets-inventory.json. ${s.note || ''}`,
    });
    continue;
  }

  const d = daysUntil(expires);
  if (d < 0) {
    findings.push({ level: 'expired', name: s.name, msg: `EXPIRED ${-d} day(s) ago (${expires}, per ${source}). ${s.note || ''}` });
  } else if (d <= warnDays) {
    findings.push({ level: 'expiring', name: s.name, msg: `expires in ${d} day(s) (${expires}, per ${source}). ${s.note || ''}` });
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const urgent = findings.filter((f) => f.level === 'expired' || f.level === 'expiring');
const softer = findings.filter((f) => f.level === 'unknown' || f.level === 'notice');

console.log(`[secrets-expiry] ${inv.secrets.length} credential(s) inventoried, warn window ${warnDays}d.`);
if (findings.length === 0) {
  console.log('[secrets-expiry] OK - nothing expiring within the window, no unknowns.');
} else {
  for (const f of findings) console.log(`  [${f.level}] ${f.name}: ${f.msg}`);
}

if (ISSUE_TOKEN && (urgent.length > 0 || softer.length > 0)) {
  const gh = async (path, init = {}) =>
    (await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${ISSUE_TOKEN}`, accept: 'application/vnd.github+json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    })).json();
  try {
    await gh(`/repos/${REPO}/labels`, { method: 'POST', body: JSON.stringify({ name: 'secrets-expiry', color: 'D93F0B' }) }).catch(() => {});
    const lines = [
      'Automated by `check-secrets-expiry.mjs` from `scripts/ci/secrets-inventory.json`.',
      '',
      ...(urgent.length ? ['## Action needed', '', ...urgent.map((f) => `- **${f.name}** - ${f.msg}`), ''] : []),
      ...(softer.length ? ['## Needs a date filled in / drift', '', ...softer.map((f) => `- ${f.name} - ${f.msg}`), ''] : []),
      'Rotating a credential: update its row in `secrets-inventory.json` in the same PR.',
    ];
    const body = lines.join('\n');
    const existing = await gh(`/repos/${REPO}/issues?state=open&labels=secrets-expiry&per_page=1`);
    if (Array.isArray(existing) && existing.length > 0) {
      await gh(`/repos/${REPO}/issues/${existing[0].number}`, { method: 'PATCH', body: JSON.stringify({ title: `Secrets expiry watch (${new Date().toISOString().slice(0, 10)})`, body }) });
      console.log(`[secrets-expiry] updated issue #${existing[0].number}`);
    } else {
      const created = await gh(`/repos/${REPO}/issues`, { method: 'POST', body: JSON.stringify({ title: `Secrets expiry watch (${new Date().toISOString().slice(0, 10)})`, body, labels: ['secrets-expiry'] }) });
      console.log(`[secrets-expiry] created issue #${created.number}`);
    }
  } catch (e) {
    console.log(`[secrets-expiry] issue delivery failed: ${e.message}`);
  }
}

process.exit(0);
