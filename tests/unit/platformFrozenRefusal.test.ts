import { describe, expect, it } from 'vitest';
import { registerReasonText } from '../../src/services/TournamentService';
import {
  PLATFORM_FROZEN_MESSAGE,
  isPlatformFrozenError,
  platformFrozenMessage,
} from '../../src/utils/platformFrozen';

describe('maintenance entry refusals keep one player-facing meaning', () => {
  it('recognises both a trigger error and the structured first-lock refusal', () => {
    expect(isPlatformFrozenError({ code: '55006' })).toBe(true);
    expect(isPlatformFrozenError({ message: 'PLATFORM_FROZEN: no chips moved' })).toBe(true);
    expect(isPlatformFrozenError({ ok: false, reason: 'platform_frozen' })).toBe(true);
    expect(platformFrozenMessage({ ok: false, reason: 'platform_frozen' })).toBe(
      PLATFORM_FROZEN_MESSAGE
    );
    expect(isPlatformFrozenError({ reason: 'registration_closed' })).toBe(false);
  });

  it('maps a last-hand registration refusal instead of leaking its wire code', () => {
    expect(registerReasonText('platform_frozen')).toBe(PLATFORM_FROZEN_MESSAGE);
    expect(registerReasonText('platform_frozen')).not.toContain('Could not register');
  });
});
