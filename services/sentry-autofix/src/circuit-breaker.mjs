// Supabase-backed dedup + rate limit for autofix attempts.
//
// Table: autofix_attempts (see supabase/migrations/20260420120000_autofix_attempts.sql)
// Statuses:
//   queued      -> webhook accepted, dispatch fired
//   running     -> GH Action claimed the job
//   pr_opened   -> PR created, awaiting CI / merge
//   merged      -> fix shipped
//   rejected    -> fix denied by policy (denylist, rate limit, loop)
//   errored     -> exception somewhere in the pipeline
//
// A unique partial index enforces "only one open attempt per Sentry issue"
// (see migration). We additionally rate-limit per rolling 1h and 24h.

import { createClient } from '@supabase/supabase-js';

let client = null;
function sb() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  client = createClient(url, key, {
    auth: { persistSession: false },
    global: {
      headers: {
        'x-smarter-data-actor': 'service',
        'x-smarter-data-protocol': '1',
      },
    },
  });
  return client;
}

/**
 * Attempt to reserve a slot for fixing a Sentry issue.
 * Returns { ok: true, attemptId } if we should proceed, or
 * { ok: false, reason, attemptId? } if we should skip.
 */
export async function reserveAttempt({ repo, issueId, fingerprint, projectSlug, title, level }) {
  const s = sb();

  // Rate limit check (advisory — a race here can overshoot by 1).
  const hourLimit = Number(process.env.AUTOFIX_RATE_LIMIT_HOURLY || 3);
  const dayLimit = Number(process.env.AUTOFIX_RATE_LIMIT_DAILY || 10);
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 86400_000).toISOString();

  const { count: hourCount, error: hourErr } = await s
    .from('autofix_attempts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', oneHourAgo);
  if (hourErr) return { ok: false, reason: `rate-limit query failed: ${hourErr.message}` };
  if ((hourCount ?? 0) >= hourLimit) return { ok: false, reason: `hourly rate limit reached (${hourCount}/${hourLimit})` };

  const { count: dayCount, error: dayErr } = await s
    .from('autofix_attempts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', oneDayAgo);
  if (dayErr) return { ok: false, reason: `rate-limit query failed: ${dayErr.message}` };
  if ((dayCount ?? 0) >= dayLimit) return { ok: false, reason: `daily rate limit reached (${dayCount}/${dayLimit})` };

  // Insert reservation. Unique partial index (on open statuses) will reject
  // duplicates for the same issue.
  const { data, error } = await s
    .from('autofix_attempts')
    .insert({
      repo,
      sentry_issue_id: String(issueId),
      sentry_project_slug: projectSlug,
      fingerprint,
      title,
      level,
      status: 'queued',
    })
    .select('id')
    .single();

  if (error) {
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('duplicate') || msg.includes('unique') || msg.includes('23505')) {
      return { ok: false, reason: 'duplicate: open attempt exists for this issue' };
    }
    return { ok: false, reason: `insert failed: ${error.message}` };
  }

  return { ok: true, attemptId: data.id };
}

export async function markStatus(attemptId, status, fields = {}) {
  const s = sb();
  const { error } = await s
    .from('autofix_attempts')
    .update({ status, ...fields, updated_at: new Date().toISOString() })
    .eq('id', attemptId);
  if (error) {
    // Log only — a status-update failure must not break the request path.
    console.error(JSON.stringify({ level: 'error', msg: 'markStatus failed', attemptId, status, err: error.message }));
  }
}
