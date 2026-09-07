/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — A GATE THAT GATES NOTHING MUST NOT EXIST
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `TOSGuard` wrapped the ENTIRE router in App.tsx and its whole body was
 * `return <>{children}</>`, under a doc comment describing everything it would
 * do "when enabled". The app read as gated and gated nothing, and the evidence
 * was unambiguous on 2026-09-02:
 *
 *   * 0 of 1,308 profiles had `club_arena_tos_accepted_at` set. Not few — zero,
 *     since the column was created.
 *   * `ProfileService.getTOSStatus` and `acceptTOS`: no callers anywhere.
 *   * `TOSAcceptanceModal`: a complete, working modal, imported by nothing.
 *   * `/api/club-arena/accept-tos`: a complete, working endpoint, called by
 *     nothing — its only mention in either repo was a rate-limiter entry.
 *
 * Every piece existed; none were connected. A second identical stub
 * (`components/auth/TermsGate.tsx`) sat beside it, also unused.
 *
 * An inert guard is worse than no guard: it answers the question "is this
 * enforced?" with a file that looks like enforcement. This law is why the
 * three shapes below are now checked rather than assumed.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/** Source with comments stripped — this file's own prose names the column and
 *  the old stub, and neither is code. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const GUARD = 'src/components/legal/TOSGuard.tsx';

describe('LAW: the TOS guard actually asks', () => {
  const guard = read(GUARD);

  it('is not a passthrough', () => {
    /* The exact shape that shipped was a body whose ONLY statement returned
       its children. Counting statements is the honest check: this guard
       legitimately ends with `return <>{children}</>` for the accepted case,
       so a regex looking for that string would fire on the fixed version too
       — which is how a pin ends up being weakened by the next author instead
       of the bug being fixed. */
    const body = code(GUARD).slice(code(GUARD).indexOf('export default function TOSGuard'));
    expect(body, 'the guard must decide something before rendering').toContain('useEffect');
    // Lazy-loaded and wrapped in Suspense, so the render is not on the `return`
    // line - the pin is that the modal is rendered inside the not_accepted branch.
    expect(body, 'the guard must have a blocking branch').toMatch(/<TOSAcceptanceModal onAccept=/);
  });

  it('reads the acceptance status from the canonical source', () => {
    /* `profiles.club_arena_tos_accepted_at`, via getTOSStatus — the column the
       World Hub acceptance endpoint writes and the seat gate reads. NOT the
       `preferences.club_arena_tos_accepted` JSONB flag, which only the dead
       acceptTOS ever wrote and nothing has ever read. */
    expect(guard).toContain('getTOSStatus');
  });

  it('blocks with the modal when the answer is a definite no', () => {
    expect(guard).toContain('TOSAcceptanceModal');
    expect(guard).toMatch(/state === 'not_accepted'/);
  });

  it('sends the idempotency key the endpoint refuses to work without', () => {
    /* `checkIdempotency` runs first on every World Hub club-arena POST and
       answers a request with no `X-Idempotency-Key` with a 400 - before auth,
       before the write. The first landing of this gate sent none, so every
       Accept & Continue on the site failed and the modal never closed. */
    const accept = guard.slice(guard.indexOf('const handleAccept'), guard.indexOf('// Sign-in is'));
    expect(accept).toContain("'X-Idempotency-Key'");
  });

  it('records acceptance through the endpoint, not by writing the column itself', () => {
    // A browser must not be able to grant itself consent.
    expect(guard).toContain('/api/club-arena/accept-tos');
    expect(code(GUARD), 'the client must not write the column directly').not.toContain(
      'club_arena_tos_accepted_at'
    );
  });
});

describe('LAW: a failed read is not consent, and is not a lockout either', () => {
  const guard = read(GUARD);

  it('never records acceptance on a failed write', () => {
    /* An optimistic `setState('accepted')` before the response would let the
       app through on a 500 and record nothing — an account that looks accepted
       to the client and is accepted nowhere that counts. */
    const accept = guard.slice(guard.indexOf('const handleAccept'), guard.indexOf('// Sign-in is'));
    const okCheck = accept.indexOf('response.ok');
    const flip = accept.indexOf("setState('accepted')");
    expect(okCheck).toBeGreaterThan(-1);
    expect(flip, 'the state may only move after the response is checked').toBeGreaterThan(okCheck);
  });

  it("treats 'unknown' as a re-ask, not as a verdict in either direction", () => {
    /* Fail-closed here means locking 1,308 accounts out of the entire
       application on one failed PostgREST read, because this guard wraps the
       whole router. Fail-open records nothing, so it is not consent — the
       player is asked again as soon as the read succeeds. */
    expect(guard).toMatch(/'unknown'/);
    expect(guard).toContain('location.pathname');
  });

  it('leaves the terms themselves readable while the gate is up', () => {
    // Being asked to accept an agreement you cannot open is not a choice.
    expect(guard).toMatch(/ALWAYS_REACHABLE/);
    expect(guard).toMatch(/'\/legal'/);
    expect(guard).toMatch(/'\/auth'/);
  });
});

describe('LAW: no second, dead copy of the same gate', () => {
  it('TermsGate is gone', () => {
    /* An identical passthrough stub sat in components/auth. Two inert guards
       double the chance the next reader believes one of them works. */
    expect(existsSync(join(root, 'src/components/auth/TermsGate.tsx'))).toBe(false);
  });
});
