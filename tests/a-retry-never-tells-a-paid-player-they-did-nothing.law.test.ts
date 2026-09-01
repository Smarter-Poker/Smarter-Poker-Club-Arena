/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A RETRY NEVER TELLS A PAID PLAYER THEY DID NOTHING — LAW (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `retryAsync` retries on fetch / network / timeout / 503 / 502 / 429. Every
 * one of those can be raised for a request the server already COMMITTED — a
 * dropped response is indistinguishable from a dropped request. Tournament
 * registration is wrapped in it and has no idempotency key, so the second
 * attempt landed on a tournament the player was now registered for, the RPC
 * correctly answered `already_registered`, and the client threw
 *
 *     "Already registered for this tournament"
 *
 * at somebody whose buy-in had just been taken. The money moved and the
 * product said nothing happened.
 *
 * THE RULE. A retried write that comes back "already done" describes work THIS
 * call committed. Adopt it. Only an UNRETRIED `already_registered` is really
 * "you are already in this tournament" — from another tab, or an earlier
 * click — and saying so then is correct.
 *
 * If a pin goes red, check which. Removing the retry entirely would also pass
 * the first pin and would lose the resilience the wrapper is there for.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('a retry never tells a paid player they did nothing', () => {
  const service = read('src/services/TournamentService.ts');
  const retry = read('src/utils/retryAsync.ts');

  it('lets a write-path caller know a retry happened', () => {
    expect(retry).toContain('onRetry?: (attempt: number) => void');
    expect(retry).toContain('onRetry?.(attempt + 1)');
    // A caller's bookkeeping must never break the retry it is watching.
    expect(retry).toMatch(/try \{\s*onRetry\?\.\(attempt \+ 1\);\s*\} catch/);
  });

  it('registration passes an onRetry and records it', () => {
    const block = service.slice(
      service.indexOf("supabase.rpc('fn_register_for_tournament'") - 600,
      service.indexOf("supabase.rpc('fn_register_for_tournament'") + 400
    );
    expect(block).toContain('didRetry = true');
  });

  it('adopts the registration instead of throwing, but ONLY after a retry', () => {
    expect(service).toContain("if (didRetry && res?.reason === 'already_registered')");
    expect(service).toContain('adoptExistingRegistration');
    // The ordinary path still tells the player the truth.
    expect(service).toContain('throw new Error(registerReasonText(res?.reason));');
  });

  it('the adoption reads and never writes', () => {
    const helper = service.slice(
      service.indexOf('private async adoptExistingRegistration'),
      service.indexOf('   * Register a player for a tournament')
    );
    expect(helper).toContain("from('tournament_players')");
    expect(helper).toContain('.select(');
    expect(helper).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    // Returns null on failure so the caller falls back to the ordinary error.
    expect(helper).toContain('if (error || !data) return null;');
  });

  it('still emits the balance and registration events it would have emitted', () => {
    const adoptBlock = service.slice(
      service.indexOf("if (didRetry && res?.reason === 'already_registered')"),
      service.indexOf('throw new Error(registerReasonText(res?.reason));')
    );
    expect(adoptBlock).toContain("masterBus.emit('BALANCE_UPDATED'");
    expect(adoptBlock).toContain("masterBus.emit('TOURNAMENT_REGISTERED'");
  });

  it('keeps the retry - resilience is not the thing being removed', () => {
    expect(service).toContain('await retryAsync(');
    expect(retry).toContain('isRetryableError');
  });
});
