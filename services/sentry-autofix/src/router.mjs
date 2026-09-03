// Project-slug → target repo router.
//
// Phase 5.2.1: the single webhook receiver on engine-01 now serves
// multiple code repos (Club Arena + World Hub, later Commander/Orbs).
// The Sentry org is unified; each project slug maps to exactly one
// GitHub repo that owns the code.
//
// Configure via SENTRY_PROJECT_REPOS env as JSON, e.g.:
//
//   {
//     "club-arena-client":  "Smarter-Poker/Smarter-Poker-Club-Arena",
//     "club-arena-engine":  "Smarter-Poker/Smarter-Poker-Club-Arena",
//     "world-hub":          "Smarter-Poker/Smarter-Poker-World-Hub"
//   }
//
// Falls back to legacy GITHUB_REPO if the JSON is absent (back-compat
// with Phase 5.2.0 single-repo deployments).

/**
 * @param {string} projectSlug  Sentry project slug (e.g. "world-hub")
 * @param {object} [env]        env map (defaults to process.env)
 * @returns {{ ok: boolean, repo?: string, reason?: string }}
 */
export function resolveRepo(projectSlug, env = process.env) {
  const raw = env.SENTRY_PROJECT_REPOS;
  if (raw) {
    let map;
    try {
      map = JSON.parse(raw);
    } catch (err) {
      return { ok: false, reason: `SENTRY_PROJECT_REPOS is not valid JSON: ${String(err).slice(0, 200)}` };
    }
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      return { ok: false, reason: 'SENTRY_PROJECT_REPOS must be a JSON object' };
    }
    const repo = map[projectSlug];
    if (repo && typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return { ok: true, repo };
    }
    return { ok: false, reason: `no repo mapping for project "${projectSlug}" in SENTRY_PROJECT_REPOS` };
  }

  // Back-compat: single-repo deployment
  const legacy = env.GITHUB_REPO;
  if (legacy && /^[\w.-]+\/[\w.-]+$/.test(legacy)) {
    return { ok: true, repo: legacy };
  }
  return { ok: false, reason: 'neither SENTRY_PROJECT_REPOS nor GITHUB_REPO is configured' };
}
