import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    import.meta.dirname,
    '../supabase/migrations/20261004124327_cashier_authority_and_retry_keys_are_exact.sql'
  ),
  'utf8'
);
const releaseContract = readFileSync(
  resolve(import.meta.dirname, '../scripts/verification-harness/cashier-release-contract.sql'),
  'utf8'
);
const manifest = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../scripts/ci/schema-manifest.d/cashier-authority-and-exact-intent.json'
    ),
    'utf8'
  )
) as { functions: string[] };

const occurrences = (needle: string) =>
  (sql.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

describe('cashier authority and exact intent', () => {
  it('owns every retry key globally and binds exact intent', () => {
    expect(sql).toContain('operation_id uuid PRIMARY KEY');
    expect(sql).not.toContain('PRIMARY KEY(actor_user_id,operation_id)');
    expect(sql).toContain("'cashier-exact-intent:' || p_operation");
    expect(sql).not.toContain("'cashier-exact-intent:' || v_actor");
    expect(sql).toMatch(/WHERE operation_id = p_operation\s+FOR UPDATE/);
    expect(sql).toContain('v_existing.actor_user_id IS DISTINCT FROM v_actor');
    expect(sql).toContain('v_existing.operation_intent IS DISTINCT FROM p_intent');
    expect(sql).toContain('operation_id = p_operation AND actor_user_id = auth.uid()');
    expect(sql).toContain('That Legacy Retry Key Cannot Be Verified');
    expect(sql).toMatch(/FROM public\.chip_requests r\s+WHERE r\.op_id = p_operation/);
  });

  it('guards all nine browser cashier mutation doors', () => {
    expect(occurrences('v_gate := public.fn_cashier_exact_intent_begin(')).toBe(9);
    expect(occurrences('IF p_op_id IS NULL THEN')).toBeGreaterThanOrEqual(9);
    for (const name of [
      'fn_club_bank_send_core_20261004',
      'fn_club_bank_claim_core_20261004',
      'fn_club_bank_reverse_core_20261004',
      'fn_admin_remove_chips_core_20261004',
      'fn_promo_wallet_send_core_20261004',
      'fn_club_promo_send_core_20261004',
      'fn_agent_wallet_send_core_20261004',
      'fn_agent_wallet_claim_back_core_20261004',
      'fn_request_chips_core_20261004',
    ]) {
      expect(sql).toContain(name);
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION[\\s\\S]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      );
    }
    expect(sql).not.toContain('coalesce(p_op_id, gen_random_uuid())');
  });

  it('claims a request retry key before the retained chip-request core', () => {
    const wrapperStart = sql.indexOf('CREATE FUNCTION public.fn_request_chips(');
    const wrapperEnd = sql.indexOf('REVOKE ALL ON FUNCTION', wrapperStart);
    const wrapper = sql.slice(wrapperStart, wrapperEnd);
    expect(wrapperStart).toBeGreaterThanOrEqual(0);
    expect(wrapper).toContain("'action', 'chip_request'");
    expect(wrapper).toContain("'note', nullif(btrim(coalesce(p_note, '')), '')");
    expect(wrapper.indexOf("fn_cashier_exact_intent_begin('chip_request'")).toBeGreaterThanOrEqual(
      0
    );
    expect(wrapper.indexOf("fn_cashier_exact_intent_begin('chip_request'")).toBeLessThan(
      wrapper.indexOf('fn_request_chips_core_20261004')
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*public\.fn_request_chips_core_20261004\(uuid, numeric, text, uuid\)[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*public\.fn_request_chips\(uuid, numeric, text, uuid\)[\s\S]*TO authenticated, service_role/
    );
    expect(manifest.functions).toEqual(
      expect.arrayContaining(['fn_request_chips', 'fn_request_chips_core_20261004'])
    );
  });

  it('pins every private retained core by body and execution posture', () => {
    const exactCorePins = [
      [
        'fn_club_bank_send_core_20261004',
        'fn_club_bank_send',
        '20260903170529_the_hierarchy_sends_are_one_journal_row_each.sql',
        'fd7ee70c034f97894cedc51e1b413182',
      ],
      [
        'fn_club_bank_claim_core_20261004',
        'fn_club_bank_claim_back',
        '20260903170529_the_hierarchy_sends_are_one_journal_row_each.sql',
        'e9e3e8b0fef662612d4cedb68fee6c6c',
      ],
      [
        'fn_club_bank_reverse_core_20261004',
        'fn_club_bank_reverse',
        '20260903170529_the_hierarchy_sends_are_one_journal_row_each.sql',
        '371e4f56185eb90bbf43b6967d61ea55',
      ],
      [
        'fn_admin_remove_chips_core_20261004',
        'fn_admin_remove_player_chips',
        '20260903170529_the_hierarchy_sends_are_one_journal_row_each.sql',
        'ac293c1623da0db62d74f5e888c1011a',
      ],
      [
        'fn_promo_wallet_send_core_20261004',
        'fn_promo_wallet_send',
        '20260903170529_the_hierarchy_sends_are_one_journal_row_each.sql',
        'b101fc1f3280218d04d7addd155ed4ea',
      ],
      [
        'fn_agent_wallet_claim_back_core_20261004',
        'fn_agent_wallet_claim_back',
        '20260831235990_cashier_authorization_and_audit_contracts.sql',
        'cf7af5fd327c68c935a58e864537cc7a',
      ],
      [
        'fn_request_chips_core_20261004',
        'fn_request_chips',
        '20260906093024_cashier_rpc_idempotency_and_telemetry_boundary.sql',
        '7e5233ef53474fdf4f79ec8a64d6c064',
      ],
    ] as const;
    for (const [name, sourceName, sourceFile, hash] of exactCorePins) {
      expect(releaseContract).toContain(name);
      expect(releaseContract).toContain(`'hash', '${hash}'`);
      const source = readFileSync(
        resolve(import.meta.dirname, '../supabase/migrations', sourceFile),
        'utf8'
      );
      const start = source.search(
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${sourceName}\\s*\\(`, 'i')
      );
      expect(start).toBeGreaterThanOrEqual(0);
      const definition = source.slice(start);
      const delimiterMatch = definition.match(/\bas\s+(\$[A-Za-z0-9_]*\$)/i);
      expect(delimiterMatch).not.toBeNull();
      const delimiter = delimiterMatch![1];
      const bodyStart = delimiterMatch!.index! + delimiterMatch![0].length;
      const bodyEnd = definition.indexOf(delimiter, bodyStart);
      expect(bodyEnd).toBeGreaterThan(bodyStart);
      expect(createHash('md5').update(definition.slice(bodyStart, bodyEnd)).digest('hex')).toBe(
        hash
      );
    }
    const retainedProductionPins = [
      [
        'fn_club_promo_send_core_20261004',
        'docs/audits/2026-09-10-union-accounting-proposal/live-function-inventory.json',
        'fe490fcc75f305338160eca2a7a88b25',
      ],
      [
        'fn_agent_wallet_send_core_20261004',
        'supabase/accounting/credit-reduction-v1/guard-lock-successor-sources.json',
        '7a357ba95a8ca4eb13f00f798233d8d4',
      ],
    ] as const;
    for (const [name, evidenceFile, hash] of retainedProductionPins) {
      expect(releaseContract).toContain(name);
      expect(releaseContract).toContain(`'hash', '${hash}'`);
      const evidence = readFileSync(resolve(import.meta.dirname, '..', evidenceFile), 'utf8');
      expect(evidence).toContain(hash);
    }
    expect(releaseContract).toContain("v_actual_owner IS DISTINCT FROM 'postgres'");
    expect(releaseContract).toContain('v_security_definer IS DISTINCT FROM true');
    expect(releaseContract).toContain('v_search_path_pinned IS DISTINCT FROM true');
    expect(releaseContract).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
    expect(releaseContract).toContain("has_function_privilege('authenticated', v_oid, 'EXECUTE')");
    expect(releaseContract).toContain("has_function_privilege('service_role', v_oid, 'EXECUTE')");
  });

  it('serializes suspension without inverting the retained money lock order', () => {
    expect(sql).toContain("auth.role() = 'service_role'");
    expect(sql).toContain("'cashier-agent-authority:' || p_club || ':' || v_actor");
    expect(sql).toContain('cashier_agent_status_mutex_update');
    expect(sql).toContain('cashier_agent_status_mutex_delete');
    expect(sql).toContain("v_status IS DISTINCT FROM 'active'");
    expect(sql).not.toContain('FOR SHARE');
    for (const trigger of [
      'cashier_club_balance_actor_guard',
      'cashier_member_balance_actor_guard',
      'cashier_agent_balance_actor_guard',
    ]) {
      expect(sql).toContain(trigger);
    }
  });

  it('joins retained cashier doors to the same global retry-key namespace', () => {
    expect(sql).toContain('fn_cashier_operation_mutex_guard');
    expect(sql).toContain('cashier_club_operation_mutex');
    expect(sql).toContain('cashier_member_operation_mutex');
    expect(sql).toContain('cashier_agent_operation_mutex');
    expect(sql).toContain('fn_cashier_operation_intent_guard');
    expect(sql).toContain('cashier_retry_key_reused_across_actions');
    expect(sql).toContain("WHEN 'agent_wallet_send' THEN 'agent_wallet_send'");
    expect(sql).toContain("WHEN 'agent_wallet_claim_back' THEN 'agent_wallet_claim_back'");
    expect(sql).toContain("('club_members', 'cashier_member_balance_actor_guard'");
    expect(sql).toContain("('club_members', 'cashier_member_operation_mutex'");
  });

  it('uses one active hierarchy for roster, transfers, statements, RLS and classic ledger', () => {
    expect(sql).toContain('fn_club_active_cashier_edges');
    expect(sql).toMatch(/fn_club_is_in_downline[\s\S]*fn_club_active_cashier_edges/);
    expect(sql).toMatch(/fn_club_cashier_members[\s\S]*fn_club_active_cashier_edges/);
    expect(sql).toMatch(/fn_cashier_statement_downline[\s\S]*fn_club_active_cashier_edges/);
    expect(sql).toMatch(/fn_club_trade_ledger[\s\S]*fn_club_active_cashier_edges/);
    expect(sql).toMatch(
      /fn_club_trade_ledger[\s\S]*notes text,\s*metadata jsonb, from_name text, to_name text/
    );
    expect(sql).toMatch(/v_limit integer := least\(greatest\(coalesce\(p_limit, 50\), 1\), 251\)/);
    expect(sql).toMatch(
      /fn_club_trade_ledger[\s\S]*SET search_path TO 'public', 'pg_temp'\s*SET lock_timeout TO '5s'/
    );
    expect(sql.match(/ct\.notes, ct\.metadata/g)).toHaveLength(3);
    expect(sql.match(/ORDER BY ct\.created_at DESC, ct\.id DESC/g)).toHaveLength(3);
    expect(sql).toMatch(/fn_cashier_statement_scope[\s\S]*fn_club_bank_role/);
  });
});
