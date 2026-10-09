/**
 * LAW: A REFUSED HAND WHOSE SEATS HAVE ALL CLOSED FREES ITS TABLE, AND A
 * DIAMOND FREE BUY IS THE DIAMOND FREEROLL (2026-10-09).
 *
 * Three Diamond cash tables dealt nothing for two days behind one refused,
 * rolled-back hand each whose chairs had all closed: the resume door only
 * disposed a hand some later hand had dealt past. And the four Diamond Arena
 * "$100 Freeroll" schedules were refused on every poll because the Diamond
 * tournament core still refused freeBuy outright.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const REFUSED = read(
  'supabase/migrations/20261009161306_a_refused_hand_whose_seats_closed_is_disposed.sql'
);
const FREEBUY = read(
  'supabase/migrations/20261009161341_a_diamond_free_buy_is_the_diamond_freeroll.sql'
);

describe('a refused hand frees its table; a Diamond free buy is the freeroll', () => {
  for (const [name, sql] of [
    ['refused hand', REFUSED],
    ['free buy', FREEBUY],
  ] as const) {
    it(`${name}: one transaction, a live proof, a pinned preimage and a proof block`, () => {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
      expect(sql).toMatch(/^-- @live-proof: /m);
      expect(sql).toMatch(/_PREIMAGE_CHANGED/);
      expect(sql).toMatch(/DO \$prove\$/);
      expect(sql).toMatch(/v_n <> 1 THEN\s*RAISE EXCEPTION '[A-Z_]+_ANCHOR_CHANGED/);
      expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(
        /\b(?:DROP|cron\.(?:schedule|alter_job|unschedule)|GRANT)\b/i
      );
    });
  }

  it('the disposal is a cash-only, zero-credit record of a hand nobody can apply', () => {
    expect(REFUSED).toContain('tournament_id IS NULL)');
    expect(REFUSED).toContain('OR public.fn_platform_frozen()');
    expect(REFUSED).toContain("hashtextextended('hand:disposal:' || p_table_id::text, 0)");
    expect(REFUSED).toContain("'credit', 0)");
    expect(REFUSED).toContain("interval '30 minutes'");
    // A canonical refusal for this exact request.
    expect(REFUSED).toMatch(
      /EXISTS \(SELECT 1 FROM smarter_private\.hand_submission_failures f\s+WHERE f\.submission_id = s\.submission_id AND f\.request_hash = s\.request_hash\)/
    );
    // Every chair it names has closed.
    expect(REFUSED).toMatch(
      /NOT EXISTS \(SELECT 1 FROM jsonb_array_elements\(s\.request->'p_stacks'\) x\s+JOIN public\.table_seats seat ON seat\.id = \(x->>'seat_id'\)::uuid\s+WHERE seat\.left_at IS NULL\)/
    );
    for (const proof of [
      'public.hand_atomic_commits a',
      'public.hand_history hh',
      'smarter_private.hand_submission_disposals dd',
      'smarter_private.hand_submission_handoffs h',
      'smarter_private.hand_submission_dispatch d',
      'smarter_private.f06_hand_permits p',
      'public.engine_table_leases l',
    ]) {
      expect(REFUSED).toContain(`NOT EXISTS (SELECT 1 FROM ${proof}`);
    }
    expect(REFUSED).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.hand_submission_dispose_refused_vacated(uuid, uuid) FROM PUBLIC;'
    );
  });

  it('the resume door calls it beside the dealt-past disposal, for a cash table only', () => {
    expect(REFUSED).toContain(
      'OR smarter_private.hand_submission_dispose_refused_vacated(p_table_id,s.submission_id)>0) THEN'
    );
    expect(REFUSED).toContain(
      ' IF tour IS NULL AND ((EXISTS(SELECT 1 FROM public.hand_atomic_commits'
    );
  });

  it('a free buy is admitted only on a zero-entry event', () => {
    expect(FREEBUY).toMatch(
      /IF COALESCE\(\(v_cfg->>'freeBuy'\)::boolean,false\)\s+AND COALESCE\(NULLIF\(v_cfg->>'buyIn',''\)::numeric,0\) <> 0 THEN\s+RAISE EXCEPTION 'diamond_tournament_format_not_open'/
    );
  });
});
