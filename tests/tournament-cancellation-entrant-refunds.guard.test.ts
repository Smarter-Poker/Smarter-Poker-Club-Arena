import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const probe = readFileSync(
  resolve(__dirname, '../scripts/ci/probes/tournament-cancellation-entrant-refunds.sql'),
  'utf8'
);

describe('entrant cancellation probe preserves current policy assertions', () => {
  it('runs installed registration, cancellation and durable replay authorities', () => {
    expect(probe).toContain('public.fn_register_for_tournament_request(');
    expect(probe).not.toContain('public.fn_register_for_tournament(');
    expect(probe).toContain('public.atomic_cancel_tournament(');
    expect(probe.match(/public\.atomic_cancel_tournament\(/g)).toHaveLength(3);
    expect(probe).toContain('public.fn_ca_tournament_cancellation_receipt(');
    expect(probe).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(probe).toContain('SET CONSTRAINTS tournaments_cancel_must_refund IMMEDIATE');
  });

  it('pins origin-wallet cash for both funding kinds, no new ticket and exact fee attribution', () => {
    expect(probe).toContain("e.entitlement_kind='wallet_charge'");
    expect(probe).toContain("'satellite_seat','satellite_seat'");
    expect(probe).toContain("(v_first->>'ticket_return_count')::integer IS DISTINCT FROM 0");
    expect(probe).toContain("(v_first->>'refund_line_count')::integer IS DISTINCT FROM 2");
    expect(probe).toContain("(v_first->>'total_refunded')::numeric IS DISTINCT FROM 200::numeric");
    expect(probe).toContain('OR EXISTS(SELECT 1 FROM public.tournament_tickets tk');
    expect(probe).toContain('w.user_id=v_sat_user');
    expect(probe).toContain('tr.source_wallet_club_id=v_fee_club');
    expect(probe).toContain("r.source='atomic_cancel_tournament'");
    expect(probe).toContain("r.metadata->>'kind'='tournament_fee_refund'");
    expect(probe).toContain('r.club_id<>v_fee_club');
  });

  it('requires byte-identical replay, immutable evidence and rollback cleanup', () => {
    expect(probe).toContain('v_replay IS DISTINCT FROM v_first');
    expect(probe).toContain('v_verified IS DISTINCT FROM v_first');
    expect(probe).toContain('tournament_cancellation_receipts');
    expect(probe).toContain("EXCEPTION WHEN SQLSTATE '55000'");
    expect(probe).toContain('v_receipt.fee_reversal_ids[1]');
    expect(probe.match(/^ROLLBACK;$/gm)).toHaveLength(1);
    expect(probe.trim()).toContain('TOURNAMENT_CANCELLATION_ENTRANT_REFUNDS_PASS');
  });
});
