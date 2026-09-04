/**
 * e2e-port.mjs - give every runner its own preview port.
 *
 * WHY (2026-09-04). Three Playwright surfaces bound FIXED ports: 4173 (the
 * CSS Beat preview), 5188 (Table Studio) and 5189 (financial decisions). That
 * was fine while those jobs ran on GitHub-hosted runners, where every job gets
 * a private VM. It stopped being fine the moment CI moved onto the estate:
 * three 16-core boxes with TWELVE runners each, all sharing one network
 * namespace. Two pull requests reaching the same step at the same time is not
 * a rare race, it is the normal case at this push rate - and the failure is
 * loud but misleading:
 *
 *   Error: http://127.0.0.1:5188/hub/club-arena/ is already used, make sure
 *   that nothing is running on the port/url or set reuseExistingServer:true
 *
 * The obvious "fix" that error suggests - `reuseExistingServer: true` - is the
 * WORST possible answer here. It would silently run one pull request's specs
 * against another pull request's build. The config comment already warns about
 * exactly that ("Reusing port 5173 can silently test a different worktree and
 * bless the wrong UI"). The port has to be unique instead.
 *
 * A self-hosted runner's RUNNER_NAME is unique per runner process and stable
 * for the life of the job, which is precisely the scope that needs to be
 * distinct. Offsets are multiples of 10, so two bases that differ by less than
 * 10 (5188 and 5189) can never be mapped onto each other.
 *
 * Locally, and on a GitHub-hosted runner, RUNNER_NAME is absent or the VM is
 * private, so the base port is returned unchanged and nothing about a
 * developer's `npx playwright test` changes.
 *
 * Usage:
 *   import { portFor } from './scripts/ci/e2e-port.mjs';
 *   node scripts/ci/e2e-port.mjs 4173     # prints the port for this runner
 */

const SLOTS = 300; // 300 * 10 = a 3000-port window above the base

export function portFor(base) {
  // CA_E2E_PORT_OFFSET is the explicit override, for anyone who needs to pin
  // a port by hand (debugging a hung preview, say).
  const explicit = process.env.CA_E2E_PORT_OFFSET;
  if (explicit !== undefined && explicit !== '') {
    const n = Number(explicit);
    if (Number.isFinite(n)) return base + Math.trunc(n) * 10;
  }

  // Only self-hosted runners share a host. A GitHub-hosted runner has the VM
  // to itself, and `runner.environment` is not visible here, but its
  // RUNNER_NAME is a per-run throwaway anyway, so hashing it is harmless.
  const id = process.env.RUNNER_NAME || '';
  if (!id) return base;

  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return base + (h % SLOTS) * 10;
}

// CLI: `node scripts/ci/e2e-port.mjs 4173`
if (import.meta.url === `file://${process.argv[1]}`) {
  const base = Number(process.argv[2]);
  if (!Number.isFinite(base)) {
    console.error('usage: node scripts/ci/e2e-port.mjs <base-port>');
    process.exit(2);
  }
  process.stdout.write(String(portFor(base)));
}
