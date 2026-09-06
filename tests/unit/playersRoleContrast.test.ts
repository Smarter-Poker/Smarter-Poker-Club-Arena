import { describe, expect, it } from 'vitest';

import { ROLE_BADGE } from '../../src/components/club/RoleBadge';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  );
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Players Role Labels', () => {
  it('keeps every role color readable on the darkest Player Record plate', () => {
    for (const [role, badge] of Object.entries(ROLE_BADGE)) {
      expect(contrast(badge.color, '#070B0F'), `${role} role contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
