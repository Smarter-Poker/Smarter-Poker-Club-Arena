import { describe, expect, it } from 'vitest';
import type { HorseAuthorityVerdict } from '../../engine/HorseQualifiedAuthority.js';
import { correctiveBaselineCompositionIsUsable } from './kernelComposition.js';

const selected = (verdict: HorseAuthorityVerdict = 'usable', callerMode: unknown = undefined) => ({
  selected: true,
  callerMode,
  verdict,
});

describe('corrective baseline composition authority', () => {
  it('requires every selected baseline owner to remain usable', () => {
    expect(correctiveBaselineCompositionIsUsable([selected(), selected(), selected()])).toBe(true);
    expect(correctiveBaselineCompositionIsUsable([])).toBe(true);
  });

  it.each([
    'unselected',
    'refused',
    'refresh_failed',
    'withdrawn',
    'expired',
    'restarted',
    'missing_receipt',
    'stale_generation',
    'mismatched',
  ] as const)('refuses a selected baseline owner with verdict %s', (verdict) => {
    expect(correctiveBaselineCompositionIsUsable([selected(), selected(verdict), selected()])).toBe(
      false
    );
  });

  it('refuses a caller disabling any selected baseline owner', () => {
    expect(correctiveBaselineCompositionIsUsable([selected('usable', 'off')])).toBe(false);
    expect(correctiveBaselineCompositionIsUsable([selected(), selected('usable', 'off')])).toBe(
      false
    );
  });

  it('does not require authority for an unselected owner or substitute it for a selected owner', () => {
    const absent = { selected: false, callerMode: 'off', verdict: 'unselected' as const };
    expect(correctiveBaselineCompositionIsUsable([absent, selected()])).toBe(true);
    expect(correctiveBaselineCompositionIsUsable([absent, selected('withdrawn')])).toBe(false);
  });

  it('accepts only ordinary default/shadow or internally admitted candidate controls', () => {
    for (const callerMode of [undefined, 'shadow', 'candidate']) {
      expect(correctiveBaselineCompositionIsUsable([selected('usable', callerMode)])).toBe(true);
    }
    for (const callerMode of [null, true, {}, 'unknown']) {
      expect(correctiveBaselineCompositionIsUsable([selected('usable', callerMode)])).toBe(false);
    }
  });
});
