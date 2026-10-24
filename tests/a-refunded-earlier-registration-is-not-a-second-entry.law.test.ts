/**
 * A REFUNDED EARLIER REGISTRATION IS NOT A SECOND ENTRY (2026-10-24)
 *
 * c06ca679 "Happy Hour Bounty (NLH)": Table 20 (c30f589c) was created for one
 * late registrant (horse "ana") and never dealt. Balancing parked it, and every
 * re-admission refused F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN: the entry proof
 * counted the user's funding receipts across ALL registrations, and ana had a
 * second `entry` receipt from an earlier registration that was unregistered
 * and refunded the day before. She could never play, move or bust. Owner rule:
 * tournaments must always self-heal and finish.
 *
 * 20261024233030 changes only that count: a receipt observed before the
 * current registration began belongs to an earlier registration and is not
 * counted. This law pins the exact passage swapped, the pre-image it was
 * written against, and that the migration writes no row and moves no chip.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const FILE = '20261024233030_a_refunded_earlier_registration_is_not_a_second_entry.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const ORIGIN = readFileSync(
  join(MIGRATIONS, '20261021172832_never_dealt_arrivals_keep_their_committed_move.sql'),
  'utf8'
);

const OLD = 'AND (f.registration_id=registration.id OR f.user_id=registration.user_id))<>1';
const NEW =
  'AND (f.registration_id=registration.id OR (f.user_id=registration.user_id AND f.observed_at>=registration.registered_at)))<>1';

describe('a refunded earlier registration is not a second entry', () => {
  it('replaces exactly the receipt-count passage the never-dealt proof held', () => {
    expect(ORIGIN).toContain(OLD);
    expect(SQL).toContain(OLD);
    expect(SQL).toContain(NEW);
    expect(SQL).toContain(
      "'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure"
    );
  });

  it('asserts the pre-image, a single occurrence, and a reversible post-image', () => {
    expect(SQL).toContain("md5(v_pre) IS DISTINCT FROM '1952ea35ef547fd1102a4eca7ae1427e'");
    expect(SQL).toContain('PREIMAGE_PASSAGE');
    expect(SQL).toContain('POSTIMAGE_MISMATCH');
    expect(SQL).toContain('POSTIMAGE_NOT_REVERSIBLE');
  });

  it('is one transaction that writes no row and moves no chip', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|public\.|smarter_private\.)/i);
    expect(SQL).not.toMatch(/chip_ledger\s*\(/i);
  });
});
