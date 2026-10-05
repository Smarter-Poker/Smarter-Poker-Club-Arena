import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseLogic } from '../engine/HorseLogic.js';
import { runOmahaVariantStrengthShard } from './OmahaVariantStrengthLeague.js';
import { runPlo4StrengthShard } from './Plo4PolicyLeague.js';

/**
 * Audit 2026-10-05: Phase 10 and Phase 11 candidates proposed cent-sized
 * wagers and unrounded stack-sized calls, which HorseLogic.legalize rewrites
 * (whole-dollar chip step, all-in conversion). The selection guard refused
 * every such applied proposal as `illegal_candidate` and the reference was
 * played instead, so the strength matrices measured a mixed arm (PLO5 8%,
 * PLO6 14%, PLO8 6% of changed proposals on a development shard). Each policy
 * now receives the owner's legalizer and records and executes its proposal in
 * that exact legal form: over real league hands the guard never fires and
 * changed proposals are still applied.
 */
describe('Phase 10 and 11 candidates are in the legalizer form', () => {
  afterEach(() => vi.restoreAllMocks());

  const tally = (field: 'plo4Policy' | 'omahaVariantPolicy') => {
    const seen = { applied: 0, illegal: 0 };
    const decide = HorseLogic.decide.bind(HorseLogic);
    vi.spyOn(HorseLogic, 'decide').mockImplementation((...args) => {
      const d = decide(...args);
      const r = (
        d as unknown as Record<
          string,
          { mode?: string; applied?: boolean; selectionRefusal?: string | null }
        >
      )[field];
      if (r?.mode === 'candidate') {
        seen.applied += Number(r.applied === true);
        seen.illegal += Number(r.selectionRefusal === 'illegal_candidate');
      }
      return d;
    });
    return seen;
  };

  it.each(['plo5', 'plo6', 'plo8'] as const)(
    '%s: no candidate is refused as illegal_candidate',
    async (variant) => {
      const seen = tally('omahaVariantPolicy');
      await runOmahaVariantStrengthShard(variant, {
        profileId: `p11c-${variant}-6max-100bb`,
        seed: 11101101,
        shard: 0,
        mode: 'development',
        // Enough hands that the unfixed policies are refused (measured: PLO6
        // 15 refusals in 400 pairs on this profile and seed).
        pairs: 240,
      });
      expect(seen.applied).toBeGreaterThan(0);
      expect(seen.illegal).toBe(0);
    },
    240_000
  );

  it('plo4: no candidate is refused as illegal_candidate', async () => {
    const seen = tally('plo4Policy');
    await runPlo4StrengthShard({
      profileId: 'p10c-6max-100bb',
      seed: 10101101,
      shard: 0,
      mode: 'development',
      pairs: 60,
    });
    expect(seen.applied).toBeGreaterThan(0);
    expect(seen.illegal).toBe(0);
  }, 120_000);
});
