import { describe, expect, it } from 'vitest';
import { parseAgentPayablesPayload } from '../../src/utils/agentManagementPayload';

const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';

const row = (overrides: Record<string, unknown> = {}) => ({
  agent_id: AGENT_A,
  user_id: USER_A,
  name: 'Agent Alpha',
  role: 'agent',
  status: 'active',
  is_prepaid: false,
  credit_limit: '500.25',
  credit_used: '100.25',
  credit_available: '400.00',
  utilization: '0.2004',
  commission_rate: '0.5000',
  player_rakeback_rate: '0.3000',
  total_players: 3,
  owed: '12.25',
  rows_behind: 2,
  oldest_unsettled: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const valid = () => ({
  agents: 2,
  cap: 500,
  total_owed: '20.00',
  total_rows: 3,
  oldest_unsettled: '2026-10-01T00:00:00.000Z',
  rollup_checked_at: '2026-10-04T23:59:00.000Z',
  generated_at: '2026-10-05T00:00:00.000Z',
  rows: [
    row(),
    row({
      agent_id: AGENT_B,
      user_id: USER_B,
      name: 'Agent Beta',
      owed: '7.75',
      rows_behind: 1,
      oldest_unsettled: '2026-10-02T00:00:00.000Z',
    }),
  ],
});

describe('agent payables receipt boundary', () => {
  it('preserves exact verified money and reconciled counts', () => {
    expect(parseAgentPayablesPayload(valid())).toMatchObject({
      agents: 2,
      total_owed: 20,
      total_rows: 3,
      rows: [
        { agent_id: AGENT_A, owed: 12.25, credit_available: 400 },
        { agent_id: AGENT_B, owed: 7.75 },
      ],
    });
  });

  it.each([
    ['not an object', null],
    ['rows not an array', { ...valid(), rows: {} }],
    ['null money', { ...valid(), total_owed: null }],
    ['nonfinite money text', { ...valid(), total_owed: 'Infinity' }],
    ['subcent money', { ...valid(), total_owed: '20.001' }],
    ['wrong total', { ...valid(), total_owed: '19.99' }],
    ['wrong count', { ...valid(), total_rows: 4 }],
    ['wrong oldest row receipt', { ...valid(), oldest_unsettled: '2026-10-01T12:00:00.000Z' }],
    [
      'owed value without an unsettled row',
      {
        ...valid(),
        rows: [row({ owed: '12.25', rows_behind: 0, oldest_unsettled: null }), valid().rows[1]],
      },
    ],
    [
      'duplicate identity',
      {
        ...valid(),
        rows: [row(), row({ owed: '7.75', rows_behind: 1 })],
      },
    ],
    ['future rollup timestamp', { ...valid(), rollup_checked_at: '2026-10-05T00:00:01.000Z' }],
    [
      'future row timestamp',
      {
        ...valid(),
        rows: [row({ oldest_unsettled: '2026-10-05T00:00:01.000Z' }), valid().rows[1]],
      },
    ],
    [
      'unreconciled credit availability',
      {
        ...valid(),
        rows: [row({ credit_available: '399.99' }), valid().rows[1]],
      },
    ],
  ])('fails closed for %s', (_label, payload) => {
    expect(() => parseAgentPayablesPayload(payload)).toThrow(/Malformed/);
  });
});
