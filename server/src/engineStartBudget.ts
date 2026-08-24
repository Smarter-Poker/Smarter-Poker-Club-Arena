/**
 * C20 (2026-08-23): the engine adoption budget control law.
 *
 * Deliberately its own module with ZERO imports. It lived in GameServer.ts
 * first, and importing it from there dragged in the Supabase client, which
 * logs a FATAL when SUPABASE_SERVICE_ROLE_KEY is absent - so a pure arithmetic
 * test could only run by first half-initialising a database client it never
 * used. That is the kind of coupling that eventually turns a passing test red
 * for a reason unrelated to what it tests.
 *
 * See the engineStartBudget field in GameServer.ts for the incident, and
 * engineStartBudget.test.ts for the properties this law must hold.
 *
 * MAX 25 x 5s sweeps adopts a 180-table fleet in ~35s, which is invisible to
 * players because a table without an engine is one nobody is dealing at.
 * MIN 5 keeps the fleet converging even at full retreat (~36 sweeps) rather
 * than stalling, which would trade a slow recovery for no recovery.
 */
export const ENGINE_START_BUDGET_MAX = 25;
export const ENGINE_START_BUDGET_MIN = 5;
export const ENGINE_START_BUDGET_RECOVER = 5;

/**
 * Additive-increase / multiplicative-decrease.
 *
 * TCP uses this law for precisely this shape of problem: a shared resource
 * with no admission control, where the only feedback is failure, and where
 * every participant reacting identically to that failure is what turns
 * congestion into collapse. Retreat has to be faster than recovery, or the
 * system oscillates instead of settling.
 */
export function nextEngineStartBudget(current: number, distressed: boolean): number {
  if (distressed) {
    return Math.max(ENGINE_START_BUDGET_MIN, Math.floor(current / 2));
  }
  return Math.min(ENGINE_START_BUDGET_MAX, current + ENGINE_START_BUDGET_RECOVER);
}
