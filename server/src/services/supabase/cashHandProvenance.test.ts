import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bindCashHandManifest,
  captureCashHandProvenance,
  type CashManifestParticipant,
} from './cashHandProvenance.js';
import { captureHandSeatGenerations } from '../../engine/handSeatGeneration.js';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./client.js', () => ({ supabase: { rpc } }));
const manifest = '10000000-0000-4000-8000-000000000001';
const participant = (n: number, horse = false): CashManifestParticipant => ({
  user_id: `20000000-0000-4000-8000-00000000000${n}`,
  seat_id: `30000000-0000-4000-8000-00000000000${n}`,
  occupancy_id: `40000000-0000-4000-8000-00000000000${n}`,
  seat_joined_at: '2026-09-17T23:00:00.123456+00:00',
  stack_before: 100.01,
  is_horse: horse,
});
beforeEach(() => {
  rpc.mockReset();
});
describe('original cash funding manifest transport', () => {
  it('freezes all dealt participants before yielding, including horses and exact occupancy', async () => {
    let resolve!: (value: unknown) => void;
    rpc.mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        })
    );
    const roster = [participant(1), participant(2, true)];
    const pending = captureCashHandProvenance('table', 1000001, roster, 'engine', 'generation');
    roster[1].occupancy_id = 'new occupant';
    roster.pop();
    expect(rpc.mock.calls[0]).toEqual([
      'fn_cash_capture_hand_manifest',
      {
        p_table_id: 'table',
        p_hand_number: 1000001,
        p_participants: [participant(1), participant(2, true)],
        p_instance_id: 'engine',
        p_lease_generation: 'generation',
      },
    ]);
    resolve({ data: { version: 1, manifest_id: manifest }, error: null });
    await expect(pending).resolves.toBe(manifest);
  });
  it.each([
    { error: { message: 'unavailable' } },
    { data: { version: 2, manifest_id: manifest } },
    { data: { version: 1, manifest_id: 'fake' } },
  ])('refuses to manufacture a receipt from %j', async (response) => {
    rpc.mockResolvedValue(response);
    await expect(
      captureCashHandProvenance(
        'table',
        1000001,
        [participant(1), participant(2)],
        'engine',
        'generation'
      )
    ).rejects.toThrow();
  });
  it('keeps the frozen manifest identity through the existing settlement map copy', () => {
    const roster = [participant(1), participant(2, true)];
    const result = new Map(
      bindCashHandManifest(captureHandSeatGenerations(roster), manifest, roster)
    );
    roster[1].occupancy_id = 'replaced';
    expect(result.get(participant(2).user_id)).toEqual({
      seat_id: participant(2).seat_id,
      seat_joined_at: participant(2).seat_joined_at,
      occupancy_id: participant(2).occupancy_id,
      funding_manifest_id: manifest,
      funding_stack_before: 100.01,
    });
    expect(Object.isFrozen(result.get(participant(2).user_id))).toBe(true);
  });
  it('refuses missing and duplicate participants even when their chip delta could be zero', () => {
    const roster = [participant(1), participant(2)];
    const generations = captureHandSeatGenerations(roster);
    expect(() => bindCashHandManifest(generations, manifest, roster.slice(0, 1))).toThrow(
      'participant set mismatch'
    );
    expect(() => bindCashHandManifest(generations, manifest, [roster[0], roster[0]])).toThrow(
      'participant set mismatch'
    );
    expect(() =>
      bindCashHandManifest(generations, manifest, [{ ...roster[0], seat_id: manifest }, roster[1]])
    ).toThrow('seat generation mismatch');
  });
  it('is wired before the real controller is created and checks the lease again afterward', () => {
    const source = readFileSync('src/engine/ServerTableEngineDealing.ts', 'utf8');
    const capture = source.indexOf('const manifestId = await captureCashHandProvenance(');
    const controller = source.indexOf('this.handController = new HandController(', capture);
    expect(capture).toBeGreaterThan(0);
    expect(controller).toBeGreaterThan(capture);
    expect(source.slice(capture, controller)).toContain('this.hasCurrentEngineLeaseAuthority()');
    expect(source.slice(capture, controller)).toContain(
      "reportError(error, 'Accounting.original_cash_manifest')"
    );
  });
});
