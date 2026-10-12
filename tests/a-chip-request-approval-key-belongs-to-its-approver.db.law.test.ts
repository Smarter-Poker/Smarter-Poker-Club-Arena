/**
 * ===========================================================================
 *  LAW - A CHIP REQUEST APPROVAL KEY BELONGS TO ITS APPROVER
 * ===========================================================================
 *
 * Cashier launch audit C6-03, 2026-10-09. fn_respond_chip_request keyed its
 * send by the request alone. Since 20261004124327 that key passes the
 * exact-intent gate, which binds a key to the first actor that presents it and
 * keeps the claim when the send is refused. So one refused approval (an agent
 * with no float) left the request answerable by nobody else: the owner was
 * told "That Retry Key Belongs To A Different Cashier Request" forever.
 * Migration 20261010003544 keys the send by request AND approver; money still
 * moves once because the send and the status change commit together under the
 * request's row lock. Qualified by scripts/ci/test-chip-request-approval-db-postgres.py
 * on production's own gate and wrapper text.
 *
 * Registry: docs/laws.d/a-chip-request-approval-key-belongs-to-its-approver.md
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const HEAD = 'CREATE OR REPLACE FUNCTION public.fn_respond_chip_request(';
const NEWEST = migrationNames()
  .filter((n) => migrationText(n).includes(HEAD))
  .at(-1)!;
const BODY = sliceBetween(migrationText(NEWEST), HEAD, '$function$;');
const squash = (s: string): string => s.replace(/\s+/g, ' ');

describe('a chip request approval key belongs to its approver', () => {
  it('is defined last by the migration that fixed it, or by one that keeps the fix', () => {
    expect(NEWEST >= '20261010003544_a_chip_request_approval_key_belongs_to_its_approver.sql').toBe(
      true
    );
  });

  it('derives the send key from the request and the approver', () => {
    expect(BODY).toContain(
      "v_op_id := md5('chip_request_approve:' || p_request_id::text || ':' || v_me::text)::uuid;"
    );
    expect(BODY).not.toContain(
      "v_op_id := md5('chip_request_approve:' || p_request_id::text)::uuid;"
    );
  });

  it('still replays an approval made under the request-only key', () => {
    expect(squash(BODY)).toContain(
      "and ct.metadata ->> 'op_id' in (v_op_id::text, md5('chip_request_approve:' || p_request_id::text)::uuid::text)"
    );
  });

  it('sends and answers the request in one transaction, under the request row lock', () => {
    expect(BODY).toContain(
      'select * into v_req from chip_requests where id = p_request_id for update;'
    );
    const send = BODY.indexOf('v_send := public.fn_agent_wallet_send(');
    const answer = BODY.indexOf(
      "update chip_requests set status = 'approved', responded_by = v_me"
    );
    expect(send).toBeGreaterThan(0);
    expect(answer).toBeGreaterThan(send);
  });
});
