/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BRAIN TELEMETRY — proof of receipt (Dan 2026-08-26)
 * ═══════════════════════════════════════════════════════════════════════════
 * "Verify that all changes we make to the brain ACTUALLY MAKE IT to the
 *  horses — that they receive, utilize and improve on the new logic."
 *
 * A deploy proves the code is in the container. It does not prove a layer
 * ever FIRES at a live table — the house failure mode is precisely the
 * feature that looks deployed and never executes (the league that never ran,
 * the c-bet upgrade gated off by a stale flag, the conditioning branch dead
 * for 17% of flops). This module is the instrument: every live decision
 * stamps the layers that actually executed, a flush service aggregates them
 * per day into horse_brain_telemetry, the daily audit raises a CRITICAL
 * layer_silent finding when a deployed layer stops firing, and the admin
 * panel shows the fire counts next to the hand reviews.
 *
 * DESIGN CONSTRAINTS
 * - Live decisions only: the gate is opts.telemetry === true, set solely by
 *   scheduleHorseAction. League/benchmark/test decisions never count — a
 *   nightly self-play burst would otherwise fake "the fleet uses layer X".
 * - Zero overhead when off, O(1) map increment when on. No IO here; the
 *   flush lives in services/BrainTelemetryFlush.ts.
 * - Decisions are synchronous and single-threaded; a plain Map is safe.
 */

const fires = new Map<string, number>();
let enabled = false;

/** Armed once by the flush service at engine boot. */
export function enableBrainTelemetry(): void {
  enabled = true;
}

/** Count one execution of a brain feature for today. No-op until enabled. */
export function noteFire(feature: string): void {
  if (!enabled) return;
  fires.set(feature, (fires.get(feature) ?? 0) + 1);
}

/** True when the caller opted this decision into telemetry. */
export function telemetryOn(opts: { telemetry?: boolean } | undefined): boolean {
  return enabled && opts?.telemetry === true;
}

/** Drain the accumulated counters (flush service + tests). */
export function drainFires(): Array<{ feature: string; fires: number }> {
  const out: Array<{ feature: string; fires: number }> = [];
  for (const [feature, n] of fires) out.push({ feature, fires: n });
  fires.clear();
  return out;
}

/** Merge rows back after a failed flush so nothing is lost. */
export function restoreFires(rows: Array<{ feature: string; fires: number }>): void {
  for (const r of rows) fires.set(r.feature, (fires.get(r.feature) ?? 0) + r.fires);
}
