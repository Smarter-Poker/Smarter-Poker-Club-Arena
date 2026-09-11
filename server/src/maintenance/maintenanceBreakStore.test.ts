import { describe, expect, it } from 'vitest';
import {
  decodeMaintenanceBreakRow,
  decodeMaintenanceReleaseBoundary,
} from './maintenanceBreakStore.js';

const owner = '11111111-1111-4111-8111-111111111111';

describe('maintenance break durable row decoding', () => {
  it('accepts exact last-hand and countdown shapes', () => {
    expect(
      decodeMaintenanceBreakRow({
        phase: 'last_hand',
        announced_at: '2026-09-09T18:53:00.000Z',
        break_started_at: null,
        break_ends_at: null,
        reason: 'Scheduled Engine Maintenance',
        ownership_token: owner,
      })
    ).toMatchObject({ phase: 'last_hand', breakStartedAt: null, breakEndsAt: null });
    expect(
      decodeMaintenanceBreakRow({
        phase: 'counting_down',
        announced_at: '2026-09-09T18:53:00.000Z',
        break_started_at: '2026-09-09T18:55:00.000Z',
        break_ends_at: '2026-09-09T19:00:00.000Z',
        reason: 'Scheduled Engine Maintenance',
        ownership_token: owner,
      })
    ).toMatchObject({ phase: 'counting_down' });
  });

  it.each([
    ['invalid timestamp', { announced_at: 'not-a-time' }, 'maintenance_break_invalid_announced_at'],
    ['missing owner', { ownership_token: null }, 'maintenance_break_invalid_ownership_token'],
    [
      'last-hand with countdown fields',
      { break_started_at: '2026-09-09T18:55:00.000Z' },
      'maintenance_break_invalid_last_hand_shape',
    ],
  ])('fails closed for %s', (_name, override, message) => {
    expect(() =>
      decodeMaintenanceBreakRow({
        phase: 'last_hand',
        announced_at: '2026-09-09T18:53:00.000Z',
        break_started_at: null,
        break_ends_at: null,
        reason: 'Scheduled Engine Maintenance',
        ownership_token: owner,
        ...override,
      })
    ).toThrow(message);
  });
});

describe('maintenance release certificate decoding', () => {
  it('accepts an authoritative timestamp or the authoritative null receipt', () => {
    expect(decodeMaintenanceReleaseBoundary('2026-09-09T19:00:01.250Z')).toBe(
      Date.parse('2026-09-09T19:00:01.250Z')
    );
    expect(decodeMaintenanceReleaseBoundary(null)).toBeNull();
  });

  it.each([['not-a-time'], [0], [{}]])('fails closed for malformed value %j', (value) => {
    expect(() => decodeMaintenanceReleaseBoundary(value)).toThrow(
      'maintenance_break_invalid_release_boundary'
    );
  });
});
