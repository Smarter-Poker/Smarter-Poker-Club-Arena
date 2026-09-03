// Server-side policy: which projects we accept webhooks from, which
// issue states we actually try to fix, and any pre-dispatch gates.
//
// The *code-modification* policy (allowlist/denylist paths, test
// requirement) lives in scripts/sentry-autofix/policy.mjs inside the GH
// Action — that's where we actually touch files. Keeping the two layers
// of policy in sync is a README concern.

export function parseAllowedProjects() {
  return (process.env.SENTRY_ALLOWED_PROJECTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Decide whether an incoming Sentry webhook should be actioned.
 *
 * @param {object} payload  Sentry-normalised issue event payload
 * @returns {{ ok: boolean, reason?: string }}
 */
export function gate(payload) {
  if (process.env.AUTOFIX_ENABLED === 'false') {
    return { ok: false, reason: 'autofix kill switch active (AUTOFIX_ENABLED=false)' };
  }

  const projectSlug = payload?.project_slug || payload?.project || payload?.data?.issue?.project?.slug;
  const allowed = parseAllowedProjects();
  if (allowed.length && !allowed.includes(projectSlug)) {
    return { ok: false, reason: `project "${projectSlug}" not in SENTRY_ALLOWED_PROJECTS` };
  }

  // Sentry sends `action` = "created" | "resolved" | "assigned" | etc. on
  // issue alerts. We only fix on first creation and on reopen of a
  // previously resolved issue.
  const action = payload?.action || payload?.data?.action;
  if (action && !['created', 'unresolved', 'triggered'].includes(action)) {
    return { ok: false, reason: `action "${action}" not actionable` };
  }

  const issue = payload?.data?.issue || payload?.issue;
  const level = issue?.level || payload?.data?.event?.level;

  // fatal-level issues (process crash, OOM) go straight to the on-call
  // runbook, not autofix — they need humans.
  if (level === 'fatal') {
    return { ok: false, reason: 'level=fatal → route to on-call runbook, not autofix' };
  }

  // Sampling / performance issues are not bugs-to-fix.
  if (issue?.type && issue.type !== 'error') {
    return { ok: false, reason: `issue type "${issue.type}" is not an error` };
  }

  // Explicit "do not autofix" tag. Operators can add this to noisy issues.
  const tags = issue?.tags || payload?.data?.event?.tags || [];
  const normalizedTags = Array.isArray(tags)
    ? tags.map(t => Array.isArray(t) ? t.join('=') : (t?.key ? `${t.key}=${t.value}` : String(t)))
    : [];
  if (normalizedTags.some(t => t === 'no-autofix=true' || t === 'alert=pagerduty')) {
    return { ok: false, reason: `tag denylist match: ${normalizedTags.filter(t => t.startsWith('no-autofix') || t.startsWith('alert')).join(',')}` };
  }

  return { ok: true };
}
