import { EventEmitter } from 'node:events';
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { observeTableWalletRequests } from '../e2e/support/tableWalletRequestProof';

const actor = '11111111-1111-4111-8111-111111111111';
const table = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const page = new EventEmitter();
  const proof = observeTableWalletRequests(page as unknown as Page);
  proof.targetTable(table);
  const request = (body: unknown, path = '/rest/v1/rpc/fn_player_spendable_balance') =>
    page.emit('request', {
      url: () => `https://example.invalid${path}`,
      postDataJSON: () => body,
    });
  return { page, proof, request };
}

describe('safe real cash cold-load wallet request evidence', () => {
  it('detects the pre-fix guest cold-boot request before the table mounts', () => {
    const f = fixture();
    f.request({ p_user_id: 'guest' });
    f.proof.markTableMounted();
    f.request({ p_user_id: actor });
    expect(f.proof.stop()).toMatchObject({
      verdict: 'failed',
      counts: { guest: 1, identified: 1 },
    });
  });

  it('counts absent and empty actors without retaining unrelated or private fields', () => {
    const f = fixture();
    for (const value of [null, undefined, '', '   '])
      f.request({ p_user_id: value, secret: actor });
    f.request({ p_user_id: actor }, '/rest/v1/rpc/unrelated');
    const result = f.proof.stop();
    expect(result.counts).toEqual({ guest: 0, empty: 4, malformed: 0, identified: 0 });
    expect(JSON.stringify(result)).not.toContain(actor);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('preserves malformed bodies and parse failures as unknown', () => {
    const f = fixture();
    f.proof.markTableMounted();
    for (const body of [null, [], 'bad', { p_user_id: 7 }, { p_user_id: 'not-a-uuid' }])
      f.request(body);
    f.page.emit('request', {
      url: () => 'https://example.invalid/rest/v1/rpc/fn_player_spendable_balance',
      postDataJSON: () => {
        throw new Error('unreadable');
      },
    });
    expect(f.proof.stop()).toMatchObject({ verdict: 'unknown', counts: { malformed: 6 } });
  });

  it('never certifies absence before TablePage mounts or when the chip read was not exercised', () => {
    const unmounted = fixture();
    unmounted.request({ p_user_id: actor });
    expect(unmounted.proof.stop().verdict).toBe('unknown');
    const noRead = fixture();
    noRead.proof.markTableMounted();
    noRead.request({ p_user_id: actor }); // A global bootstrap read is not a table-wallet read.
    expect(noRead.proof.stop().verdict).toBe('unknown');
  });

  it('retains bounded classifications and removes the listener on completion', () => {
    const f = fixture();
    f.proof.markTableMounted();
    f.request({ p_user_id: actor, p_table_id: table });
    const complete = f.proof.stop();
    f.request({ p_user_id: 'guest' });
    expect(f.proof.stop()).toEqual(complete);
    expect(complete).toMatchObject({
      tableMounted: true,
      verdict: 'passed',
      counts: { identified: 1 },
    });
    expect(f.page.listenerCount('request')).toBe(0);
  });
});
