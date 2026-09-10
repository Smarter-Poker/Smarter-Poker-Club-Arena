/**
 * A VACATED SEAT CLOSES ITS SESSION AT COMMIT (2026-09-10).
 *
 * Twelve functions vacate a cash seat; one closes the session. The table-close
 * trigger covered the five that close the table. A player BUSTING - the seat
 * vacated at zero by hand settlement on a table that stays open - was still a
 * leak. This trigger sits on the seat itself so no vacate path can forget.
 *
 * It MUST be deferred. atomic_seat_cashout_locked vacates the seat first and
 * calls fn_cash_session_close after, and that close writes the rejoin-window
 * and VPIP-eviction bars (Dan 2026-09-05). A trigger firing at the vacate
 * would close the session first, the close would find nothing, and the bar
 * would silently never be written. Deferred to commit, every proper close in
 * the transaction wins; only a session nobody closed is left for it.
 *
 * Verified live: 433 open sessions == 433 live cash seats, held across three
 * readings as seats turned over, with a vpip_evicted bar written correctly
 * through the cashout path after the trigger armed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const hit = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('_a_vacated_seat_closes_its_session_at_commit.sql'))
  .sort();
const SQL = fs.readFileSync(path.join(MIGRATIONS, hit[0] ?? ''), 'utf8');

describe('the trigger is on the seat, and it is deferred', () => {
  it('exists exactly once', () => {
    expect(hit.length).toBe(1);
  });

  it('is a DEFERRABLE INITIALLY DEFERRED constraint trigger on table_seats.left_at', () => {
    expect(SQL).toContain('CREATE CONSTRAINT TRIGGER zz_close_session_when_seat_vacated');
    expect(SQL).toContain('AFTER UPDATE OF left_at ON public.table_seats');
    expect(SQL).toContain('DEFERRABLE INITIALLY DEFERRED');
  });

  it('refuses to install as anything but deferred', () => {
    // A plain AFTER trigger here pre-empts fn_cash_session_close and the
    // VPIP-eviction bar is never written. The post-condition checks the
    // catalog, not the DDL text.
    expect(SQL).toContain('tgdeferrable AND tginitdeferred');
    expect(SQL).toContain('not installed as DEFERRABLE INITIALLY DEFERRED');
  });
});

describe('what it closes, and what it must not touch', () => {
  it('fires only on the transition into vacated, only on cash tables', () => {
    expect(SQL).toContain('OLD.left_at IS NULL AND NEW.left_at IS NOT NULL');
    expect(SQL).toContain('t.tournament_id IS NULL');
  });

  it('closes only a session still open at commit, scoped to the vacated table', () => {
    expect(SQL).toContain('scope_id = NEW.table_id AND closed_at IS NULL');
  });

  it('closes as seat_vacated - a bust, not a leave - and never through the bar-writing path', () => {
    expect(SQL).toContain("closed_reason = 'seat_vacated'");
    expect(SQL).not.toContain('fn_cash_session_close(');
  });

  it('names the bar it exists to protect', () => {
    expect(SQL).toMatch(/BAR WOULD SILENTLY NEVER BE WRITTEN/);
  });
});
