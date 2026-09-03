/**
 * LAW: a guard may not be able to fail silently on a dead credential, and a
 * sweep may not be able to miss work because a list was truncated.
 *
 * Both halves are bugs that actually ran for weeks.
 *
 * 1. TOKEN SHADOWING. `push-velocity-watchdog.yml` used
 *      secrets.GH_ADMIN_PAT || secrets.VERCEL_UNIQUENESS_PAT || secrets.GITHUB_TOKEN
 *    and failed every hour with `GET commit: 401 Bad credentials` from
 *    2026-05-10 until 2026-09-03. `||` in an Actions expression takes the
 *    first NON-EMPTY value, and AN EXPIRED PAT IS NOT EMPTY - so the dead
 *    secret won every run and the perfectly good built-in token was never
 *    reached. A fallback chain does not protect against expiry; it HIDES it.
 *    And it hid it inside the workflow whose entire job is noticing silence.
 *
 *    The rule is not "never chain". It is: if you chain, something must fail
 *    LOUDLY when the first link is dead. Every surviving chain in this repo is
 *    preceded by `.github/scripts/check-token.sh`, which does exactly that.
 *
 * 2. TRUNCATED LISTS. The autopilot sweep read open pull requests with
 *    `--limit 100` while 148 were open, so 48 never had auto-merge armed and
 *    simply sat there; and `--state all --limit 500` in a repo with thousands
 *    of pull requests could report a branch as "never proposed" when its PR
 *    was merely old - whose remedy is to open a SECOND one.
 *
 *    A cap that is merely larger is still a cap, so the auto-open path now
 *    asks GitHub about the one branch by name (`?head=owner:branch`), which
 *    cannot truncate, and refuses to open anything when that answer is
 *    unavailable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const WF = join(ROOT, '.github/workflows');
const STUCK = join(ROOT, '.github/scripts/report-stuck-prs.sh');

const workflows = () =>
  readdirSync(WF)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ name: f, body: readFileSync(join(WF, f), 'utf8') }));

describe('a watchdog cannot die quietly', () => {
  it('every token fallback chain is paired with a loud token check', () => {
    const offenders: string[] = [];
    for (const { name, body } of workflows()) {
      // A chain that ends in the built-in token and starts from a secret that
      // can expire. The App-token form is fine on its own only because
      // check-token.sh runs beside it.
      // The hazard is a chain that LEADS with a secret that can expire. An
      // expired PAT is non-empty, so it wins the `||` and the working link is
      // never reached. A chain that leads with `steps.app-token.outputs.token`
      // is safe by construction: an App token is minted per run and cannot
      // expire, and if the App itself is broken the mint STEP fails loudly
      // before any of this is evaluated.
      const leadsWithRawSecret =
        /:\s*\$\{\{\s*secrets\.[A-Z0-9_]*(PAT|TOKEN)[A-Z0-9_]*\s*\|\|\s*secrets\./.test(body);
      if (!leadsWithRawSecret) continue;
      if (!body.includes('check-token.sh')) offenders.push(name);
    }
    expect(
      offenders,
      `these chain secrets without check-token.sh, so an expired one wins silently: ${offenders.join(', ')}`
    ).toEqual([]);
  });

  it('no workflow prefers a PAT over the built-in token with no guard at all', () => {
    // The exact shape that killed push-velocity-watchdog.
    for (const { name, body } of workflows()) {
      const bare = /GH_ADMIN_PAT\s*\|\|[^\n]*GITHUB_TOKEN/.test(body);
      expect(
        bare && !body.includes('check-token.sh'),
        `${name} re-creates the 2026-05-10 shape`
      ).toBe(false);
    }
  });

  it('the sweep cannot silently miss open pull requests', () => {
    const body = readFileSync(STUCK, 'utf8');
    // 148 open against --limit 100 left 48 branches unarmed and invisible.
    expect(body).not.toMatch(/gh pr list[^\n]*--state open[^\n]*--limit 100\b/);
    expect(body).toMatch(/gh pr list[^\n]*--state open[^\n]*--limit (1000|2000)\b/);
  });

  it('auto-opening a PR asks about that branch by name, not from a list', () => {
    const body = readFileSync(STUCK, 'utf8');
    const i = body.indexOf('pr create --repo');
    expect(i).toBeGreaterThan(-1);
    const before = body.slice(0, i);
    // The exact, untruncatable question, and it must be the LAST word before
    // creating anything.
    expect(before).toMatch(/pulls\?state=all&head=/);
    expect(before).toMatch(/EXISTING/);
  });

  it('an unverifiable answer never creates a pull request', () => {
    const body = readFileSync(STUCK, 'utf8');
    const i = body.indexOf('EXISTING=');
    const after = body.slice(i, body.indexOf('pr create --repo', i));
    // "unknown" must report and skip, never fall through into creation.
    expect(after).toContain('unknown');
    expect(after).toMatch(/::warning::[^\n]*not opening/);
  });

  it('check-token.sh still exists to be the loud half', () => {
    expect(existsSync(join(ROOT, '.github/scripts/check-token.sh'))).toBe(true);
  });
});
