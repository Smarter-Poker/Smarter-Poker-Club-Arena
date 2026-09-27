/**
 * AN ADMITTED TRANSFER SURVIVES ITS DEAD PROCESS (2026-09-27)
 *
 * 45 RUNNING events waited 31 hours behind a mixed custody transfer that had
 * been ADMITTED at 09:34 on 2026-09-26 by a process that died at ~13:55. The
 * admission was bound to that process's lease row, and the only generation
 * that could admit it was the one the dead lease still held, which
 * claim_tournament_lease_v2 never hands to another instance. 24 of the 45 also
 * could not complete even while the process lived: a busted player's leftover
 * presence refused F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN / ARRIVAL_UNPROVEN.
 *
 * Migration 20260927163949 adds the readmission door and a holds-nothing rule
 * for presence. Its behaviour was run against production rows in one
 * rolled-back DO block (all 45 readmitted and completed under a fresh
 * generation, chips and chairs unchanged; every negative case below refused
 * by name). This law pins the reviewed source so that exact behaviour is what
 * production installs, and pins the guards that must NOT move.
 *
 * docs/changelog/2026-09-27-an-admitted-transfer-survives-its-dead-process.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20260927163949_an_admitted_transfer_survives_its_dead_process.sql'
  ),
  'utf8'
);
// The executable SQL: every comment line removed (the header names what it does not touch).
const CODE = SQL.replace(/^\s*--.*$/gm, '');
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(signature: string): string {
  const start = SQL.indexOf(`FUNCTION ${signature}(`);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const open = SQL.indexOf('$function$', start) + '$function$'.length;
  return SQL.slice(open, SQL.indexOf('$function$', open));
}
const READMIT = body('public.fn_f06_readmit_mixed_manager_custody');
const CURRENT = body('smarter_private.f06_mixed_current_admission');
const FIND = body('public.fn_f06_find_mixed_manager_custody');
const PRESENCE = body('smarter_private.f06_mixed_adopt_presence');

const BODIES: [string, string, string][] = [
  [
    'public.fn_f06_readmit_mixed_manager_custody(uuid,uuid,uuid,jsonb)',
    READMIT,
    '348efe032d97156c1183def5f24f1aaf',
  ],
  [
    'smarter_private.f06_mixed_current_admission(uuid,uuid,uuid)',
    CURRENT,
    '6b30ff37cb81ca84d31a97f16b8c87db',
  ],
  ['public.fn_f06_find_mixed_manager_custody(uuid)', FIND, 'b6bf7747d57f7d1c2af5a7b15a630102'],
  [
    'smarter_private.f06_mixed_adopt_presence(uuid,jsonb)',
    PRESENCE,
    '4237ab63b924137b5329c399d472f59e',
  ],
];

describe('an admitted transfer survives its dead process', () => {
  it('installs exactly the reviewed bodies, asserted after install and named as live proof', () => {
    for (const [sig, text, hash] of BODIES) {
      expect(md5(text), sig).toBe(hash);
      expect(SQL).toContain(`'${sig}'::regprocedure) <> '${hash}'`);
      expect(SQL).toContain(`'${sig}'::regprocedure) = '${hash}'`);
    }
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(SQL).toMatch(/SET LOCAL lock_timeout/);
  });

  it('leaves the original admission and the completion byte-identical, before and after', () => {
    for (const [sig, hash] of [
      [
        'public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)',
        'aeaabb44975b8d138ed447687b0aea22',
      ],
      [
        'public.fn_f06_complete_mixed_manager_custody(uuid,uuid,uuid,jsonb)',
        '43aa14703d4d8f37a95f7adf6c6ed5c1',
      ],
    ]) {
      expect(SQL.split(`'${sig}'::regprocedure) <> '${hash}'`)).toHaveLength(3);
      expect(CODE).not.toMatch(
        new RegExp(`FUNCTION ${sig.split('(')[0].replace(/\./g, '\\.')}\\(`)
      );
    }
  });

  it('relaxes no guard: no trigger, constraint, lease claim or reaper is touched, nothing is deleted', () => {
    for (const forbidden of [
      /DROP\s+(TRIGGER|FUNCTION|TABLE|CONSTRAINT|INDEX)/i,
      /DISABLE\s+TRIGGER/i,
      /ALTER\s+TABLE\s+smarter_private\.f06_manager_custody_(transfers|admissions|completions)/i,
      /claim_tournament_lease_v2/,
      /reap_dead_engine_leases|f06_lease_has_pending_custody/,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+(public|smarter_private)\.\w+\s+SET\b/i,
      /chip_balance|chip_ledger|fn_add_chips|fn_credit_and_log/,
    ])
      expect(CODE).not.toMatch(forbidden);
  });

  it('keeps readmissions append-only and the chain linear', () => {
    expect(SQL).toMatch(/PRIMARY KEY \(transfer_id, generation\)/);
    expect(SQL).toMatch(/UNIQUE \(transfer_id, prior_generation\)/);
    expect(SQL).toMatch(/CHECK \(generation <> prior_generation\)/);
    expect(SQL).toMatch(
      /CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON smarter_private\.f06_manager_custody_readmissions\s+FOR EACH ROW EXECUTE FUNCTION smarter_private\.f06_manager_transfer_immutable\(\);/
    );
    expect(SQL).toMatch(
      /CREATE TRIGGER no_truncate BEFORE TRUNCATE ON smarter_private\.f06_manager_custody_readmissions\s+FOR EACH STATEMENT EXECUTE FUNCTION smarter_private\.f06_manager_transfer_immutable\(\);/
    );
    expect(SQL).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(SQL).toMatch(
      /REVOKE ALL ON smarter_private\.f06_manager_custody_readmissions FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_f06_readmit_mixed_manager_custody\(uuid,uuid,uuid,jsonb\) FROM PUBLIC, anon, authenticated;/
    );
  });

  describe('the readmission door admits exactly an admitted, uncompleted transfer, to a fresh live generation', () => {
    const order = (...needles: string[]) => {
      let at = -1;
      for (const n of needles) {
        const next = READMIT.indexOf(n, at + 1);
        expect(next, n).toBeGreaterThan(at);
        at = next;
      }
    };

    it('is fenced by the live lease of the calling generation, around the event lane, before anything is read', () => {
      order(
        'PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);',
        'PERFORM smarter_private.f06_try_lane(p_tournament_id);',
        'PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation,false);',
        'FROM smarter_private.f06_manager_custody_transfers'
      );
    });

    it('refuses a changed transfer image, another event’s transfer, an unadmitted or completed one', () => {
      expect(READMIT).toContain(
        "IF NOT FOUND OR prior.tournament_id IS DISTINCT FROM p_tournament_id OR to_jsonb(prior) IS DISTINCT FROM p_expected\n THEN RAISE EXCEPTION 'F06_MIXED_SUCCESSOR_CHANGED'; END IF;"
      );
      expect(READMIT).toContain(
        "IF NOT FOUND OR a.tournament_id IS DISTINCT FROM p_tournament_id THEN RAISE EXCEPTION 'F06_MIXED_READMISSION_UNADMITTED'; END IF;"
      );
      expect(READMIT).toContain(
        "IF EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_completions WHERE transfer_id=p_transfer_id)\n THEN RAISE EXCEPTION 'F06_MIXED_ALREADY_COMPLETE'; END IF;"
      );
    });

    it('never shares a generation: not the origin, the successor, the admitted holder or an earlier readmission', () => {
      expect(READMIT).toContain(
        "IF p_lease_generation IN (prior.origin_generation,prior.successor_generation,a.generation)\n THEN RAISE EXCEPTION 'F06_MIXED_READMISSION_GENERATION_REUSED'; END IF;"
      );
      expect(READMIT).toMatch(
        /WHERE transfer_id=p_transfer_id AND prior_generation=p_lease_generation\)\s+THEN RAISE EXCEPTION 'F06_MIXED_READMISSION_GENERATION_REUSED'/
      );
      expect(READMIT).toContain(
        "IF l IS NULL OR (l->>'lease_generation')::uuid IS DISTINCT FROM p_lease_generation OR head_g=p_lease_generation\n  THEN RAISE EXCEPTION 'F06_LEASE_FENCED'"
      );
    });

    it('a replay is bound to the exact lease row of the process that readmitted', () => {
      order(
        'SELECT * INTO r FROM smarter_private.f06_manager_custody_readmissions WHERE transfer_id=p_transfer_id AND generation=p_lease_generation FOR SHARE;',
        'IF FOUND THEN',
        'PERFORM smarter_private.f06_mixed_current_admission(p_tournament_id,p_lease_generation,p_transfer_id);'
      );
    });

    it('carries the admission’s own terminal proof and names the head it replaces', () => {
      expect(READMIT).toContain(
        'VALUES(p_transfer_id,p_tournament_id,p_lease_generation,head_g,head_identity,l,a.terminal_proof)'
      );
      expect(READMIT).not.toMatch(/f06_mixed_custody_snapshot/);
    });
  });

  it('current admission keeps the original rule and binds a readmission to its exact lease row', () => {
    expect(CURRENT).toContain(
      "IF a.generation=g THEN\n  IF a.lease_identity IS DISTINCT FROM l THEN RAISE EXCEPTION 'F06_MIXED_ADMITTED_PROCESS_CHANGED'; END IF;"
    );
    expect(CURRENT).toContain(
      "IF NOT FOUND OR r.tournament_id IS DISTINCT FROM t OR r.lease_identity IS DISTINCT FROM l THEN\n RAISE EXCEPTION 'F06_MIXED_ADMITTED_PROCESS_CHANGED'; END IF;"
    );
    expect(CURRENT.indexOf('PERFORM smarter_private.f06_authority(t,g);')).toBeGreaterThan(-1);
  });

  it('discovery names the admitted holder and whether its lease is live, never guessing', () => {
    expect(FIND).toContain(
      "admission:=jsonb_build_object('generation',head_g,'live',EXISTS(SELECT 1 FROM public.engine_tournament_leases l\n   WHERE l.tournament_id=p_tournament_id AND l.protocol_version=2 AND l.lease_generation=head_g\n   AND l.heartbeat_at>=clock_timestamp()-interval '30 seconds'));"
    );
    expect(FIND).toContain("RAISE EXCEPTION 'F06_MIXED_TRANSFER_SELECTION_UNPROVEN'");
  });

  describe('presence: a player who holds nothing has nothing to carry, and nobody else is excused', () => {
    it('holds nothing means 0 chips on the registration AND no chair in the event live or holding a chip', () => {
      expect(PRESENCE).toContain(
        'holds_nothing:=EXISTS(SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id=t AND tp.user_id=user_key::uuid AND tp.chips=0)\n  AND NOT EXISTS(SELECT 1 FROM public.table_seats b JOIN public.tables bt ON bt.id=b.table_id\n   WHERE bt.tournament_id=t AND b.user_id=user_key::uuid AND (b.left_at IS NULL OR b.stack IS DISTINCT FROM 0));'
      );
    });

    it('is used only where no chair was found, and every other refusal stays', () => {
      expect(PRESENCE.match(/IF n=0 AND holds_nothing THEN/g)).toHaveLength(2);
      expect(PRESENCE.match(/'discarded','holds_nothing'/g)).toHaveLength(2);
      for (const refusal of [
        "IF n<>1 OR original_stay IS NULL THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN'; END IF;",
        "IF n<>1 THEN RAISE EXCEPTION 'F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN'; END IF;",
        "RAISE EXCEPTION 'F06_MIXED_PRESENCE_DESTINATION_UNPROVEN'",
        "RAISE EXCEPTION 'F06_MIXED_PRESENCE_TIME_UNPROVEN'",
        "RAISE EXCEPTION 'F06_MIXED_PRESENCE_CONFLICT'",
        "RAISE EXCEPTION 'F06_HISTORICAL_LOSS_DESTINATION_CUSTODY_MISSING'",
      ])
        expect(PRESENCE).toContain(refusal);
      // A holds-nothing exit comes before the refusal it replaces, never after.
      const first = PRESENCE.indexOf('IF n=0 AND holds_nothing THEN');
      expect(first).toBeLessThan(PRESENCE.indexOf("'F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN'"));
      const second = PRESENCE.indexOf('IF n=0 AND holds_nothing THEN', first + 1);
      expect(second).toBeLessThan(PRESENCE.indexOf("'F06_MIXED_PRESENCE_ARRIVAL_UNPROVEN'"));
      expect(second).toBeGreaterThan(PRESENCE.indexOf("'F06_MIXED_PRESENCE_ORIGINAL_UNPROVEN'"));
    });
  });
});
