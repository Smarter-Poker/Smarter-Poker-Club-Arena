#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ESTATE DIGEST - one page, every morning, before the surprise does
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY (2026-09-01). Dan learned about a $1,100 Actions bill from the invoice,
 * a repo-wide cron stall from an agent's aside, and 426 unrecorded migrations
 * from a session footnote. Every one of those was knowable from existing
 * signals; nothing aggregated them for the one person who needed the picture.
 *
 * WHAT. Gathers, once a day: publish truth (is production serving main),
 * merge volume, Actions volume (the cost proxy), cron liveness, the incident
 * board, and migration-record drift. Delivers it two ways:
 *   - upserts the single 'estate-digest'-labeled GitHub issue (the archive -
 *     one issue whose body is always the latest, history in the edits), and
 *   - notifies every active platform-scope recipient in-app, exactly the way
 *     fn_ca_daily_attestation already does, so it lands where Dan already is.
 *
 * It NEVER fails the run: a digest that can only say "three sections were
 * unreadable" is still a digest, and a red daily job becomes wallpaper.
 */
import { execFileSync } from 'node:child_process';
import { supabaseServerHeaders } from '../../scripts/ci/supabase-auth-headers.mjs';

const REPO = process.env.REPO || 'Smarter-Poker/Smarter-Poker-Club-Arena';
const WH_REPO = process.env.WH_REPO || 'Smarter-Poker/Smarter-Poker-World-Hub';
// Reads (including World Hub, a different private repo) ride the App token or
// PAT; issue writes ride GITHUB_TOKEN, whose issues:write the workflow
// declares - the same split every watchdog here uses, for the same reason.
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const TOKEN_ISSUES = process.env.GH_TOKEN_ISSUES || TOKEN;
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DAY_MS = 24 * 3600_000;
const lines = [];
const problems = [];

const ghWith = (token) => async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};
const gh = ghWith(TOKEN);
const ghIssues = ghWith(TOKEN_ISSUES);

const sb = async (pathAndQuery, init = {}) => {
  const res = await fetch(`${SB_URL}${pathAndQuery}`, {
    ...init,
    headers: supabaseServerHeaders(SB_KEY, {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      prefer: 'count=exact',
      ...init.headers,
    }),
  });
  return res;
};

const section = (title) => lines.push('', `### ${title}`, '');
const item = (s) => lines.push(`- ${s}`);
const tryStep = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    problems.push(`${name}: ${String(e.message || e).slice(0, 120)}`);
    item(`(${name} unreadable today)`);
  }
};

// ── 1. Publish truth ────────────────────────────────────────────────────────
section('Publish truth');
await tryStep('publish', async () => {
  const main = await gh(`/repos/${REPO}/commits/main`);
  const info = await (await fetch('https://smarter.poker/hub/club-arena/build-info.json', { cache: 'no-store' })).json();
  const live = String(info.ca_sha || '').slice(0, 9);
  const tip = main.sha.slice(0, 9);
  if (info.ca_sha === main.sha) {
    item(`Production serves main exactly (${tip}).`);
  } else {
    const cmp = await gh(`/repos/${REPO}/compare/${info.ca_sha}...${main.sha}`).catch(() => null);
    const behind = cmp?.ahead_by;
    item(
      behind != null
        ? `Production serves ${live}, ${behind} commit(s) behind main ${tip} (built ${info.built_at}). Normal when merges are flowing; a growing gap is the publish outage signature.`
        : `Production serves ${live}; main is ${tip}; ancestry unreadable - if this persists, check publish-watchdog issues.`
    );
  }
});

// ── 2. Merge + Actions volume (the cost proxy) ─────────────────────────────
section('Volume (last 24h)');
for (const [label, repo] of [['Club Arena', REPO], ['World Hub', WH_REPO]]) {
  await tryStep(`volume ${label}`, async () => {
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const commits = await gh(`/repos/${repo}/commits?since=${since}&per_page=100`);
    const runs = await gh(`/repos/${repo}/actions/runs?created=%3E${since}&per_page=1`);
    item(`${label}: ${commits.length}${commits.length === 100 ? '+' : ''} commits to main, ${runs.total_count} workflow runs. (August ran ~740 runs/day at the $1,100 bill; ~150/day is the post-audit norm.)`);
  });
}

// ── 3. Cron liveness ────────────────────────────────────────────────────────
section('Cron liveness');
await tryStep('cron', async () => {
  const runs = await gh(`/repos/${REPO}/actions/runs?event=schedule&per_page=1`);
  const last = runs.workflow_runs?.[0];
  const ageMin = last ? Math.round((Date.now() - Date.parse(last.created_at)) / 60000) : null;
  item(
    ageMin === null
      ? 'No scheduled run found at all - the wedge, if the repo has schedules.'
      : `Last scheduled tick ${ageMin} min ago (${last.name}). Over ~90 min is the wedge signature; the self-healer in publish-watchdog cycles registrations automatically and files a cron-wedge issue when it does.`
  );
  const wedges = await gh(`/repos/${REPO}/issues?state=open&labels=cron-wedge&per_page=1`);
  if (wedges.length > 0) item(`OPEN cron-wedge issue: #${wedges[0].number} - a heal ran and awaits tick confirmation.`);
});

// ── 4. The money board ──────────────────────────────────────────────────────
section('Incident board');
await tryStep('incidents', async () => {
  const open = await sb(`/rest/v1/ca_drift_incidents?status=neq.resolved&select=severity`, { method: 'HEAD' });
  const crit = await sb(`/rest/v1/ca_drift_incidents?status=neq.resolved&severity=eq.critical&select=id`, { method: 'HEAD' });
  const resolved = await sb(`/rest/v1/ca_drift_incidents?status=eq.resolved&resolved_at=gte.${new Date(Date.now() - DAY_MS).toISOString()}&select=id`, { method: 'HEAD' });
  const n = (r) => Number((r.headers.get('content-range') || '/0').split('/')[1] || 0);
  item(`Open: ${n(open)} (${n(crit)} critical). Resolved in 24h: ${n(resolved)} - every one now carries a root cause and a correction reference by database law.`);
});

// ── 5. Migration record drift ───────────────────────────────────────────────
section('Migration record drift');
await tryStep('drift', async () => {
  let out = '';
  try {
    out = execFileSync('node', ['scripts/ci/check-applied-migrations-are-recorded.mjs'], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env },
    });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  // Real output shape: "[applied-migrations-recorded] 378 of 1000 migration(s)
  // applied since <floor> have NO FILE in this repo:"
  const m = out.match(/(\d+)\s+of\s+\d+\s+migration\(s\)[^:]*NO FILE/i) || out.match(/(\d+)\s+unrecorded/i);
  const missing = m ? Number(m[1]) : (/every applied migration has a file|0 unrecorded/i.test(out) ? 0 : null);
  item(
    missing === 0
      ? 'Every applied migration has a repo file.'
      : missing === null
        ? 'Reconciler output unparsed - see the twice-daily Applied Migrations workflow for the real number.'
        : `${missing} applied migration(s) still have no repo file (backfill in progress; the reconciler files a migration-drift issue while any remain).`
  );
});

if (problems.length) {
  section('Digest self-report');
  for (const p of problems) item(p);
}

const today = new Date().toISOString().slice(0, 10);
const body = [`One page, generated ${new Date().toISOString()} by estate-digest.yml.`, ...lines].join('\n');
console.log(body);

// ── Deliver: the single self-updating issue ────────────────────────────────
if (TOKEN) {
  try {
    await ghIssues(`/repos/${REPO}/labels`, { method: 'POST', body: JSON.stringify({ name: 'estate-digest', color: '0E8A16' }) }).catch(() => {});
    const existing = await ghIssues(`/repos/${REPO}/issues?state=open&labels=estate-digest&per_page=1`);
    if (existing.length > 0) {
      await ghIssues(`/repos/${REPO}/issues/${existing[0].number}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: `Estate Digest (${today})`, body }),
      });
      console.log(`[digest] updated issue #${existing[0].number}`);
    } else {
      const created = await ghIssues(`/repos/${REPO}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: `Estate Digest (${today})`, body, labels: ['estate-digest'] }),
      });
      console.log(`[digest] created issue #${created.number}`);
    }
  } catch (e) {
    console.log(`[digest] issue delivery failed: ${e.message}`);
  }
}

// ── Deliver: in-app, to the same recipients the attestation reaches ────────
if (SB_URL && SB_KEY) {
  try {
    const res = await sb(`/rest/v1/ca_incident_recipients?scope=eq.platform&active=eq.true&select=user_id`);
    const recips = res.ok ? await res.json() : [];
    let sent = 0;
    for (const r of [...new Set(recips.map((x) => x.user_id))]) {
      const ok = await sb(`/rest/v1/rpc/fn_raise_notification`, {
        method: 'POST',
        body: JSON.stringify({
          p_user_id: r,
          p_type: 'estate_digest',
          p_title: `Estate Digest ${today}`,
          p_message: lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2)).join(' | ').slice(0, 900),
          p_link: '/hub/club-arena/financial-incidents',
          p_data: { source: 'estate-digest.yml', date: today },
        }),
      });
      if (ok.ok) sent++;
    }
    console.log(`[digest] in-app notifications: ${sent}/${recips.length}`);
  } catch (e) {
    console.log(`[digest] in-app delivery failed: ${e.message}`);
  }
}

process.exit(0);
