/**
 * THE CONTRACT THE TWO SIDES SPEAK, READ OFF THE SERVER THAT IS RUNNING.
 *
 * On 2026-09-23 four Diamond Spins migrations were applied to production while
 * the client that matched them was still on a branch. `fn_wheel_state_v2` and
 * `fn_wheel_spin_v2` began answering `contract_version: 4, model: 'wheel-v4'`,
 * the deployed client accepted only 2 or 3, and every wheel page threw
 * "Diamond Spins Availability Could Not Be Confirmed" and reconnected forever.
 *
 * A fixture of receipts proves the client can READ what the server sent. It
 * cannot prove the client's own copy of the prize law is the law the server
 * draws from: a receipt is one draw, and the weights that made it are the
 * server's. So the bodies of the functions that hold the law are captured here
 * byte-exact from `pg_proc.prosrc` (see the fixture's `_read`), parsed, and
 * compared with the constants the browser recomputes a spin from. If somebody
 * changes a weight, a label, a multiplier or the floor formula on one side
 * only, this goes red naming the side that moved.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import live from '../fixtures/diamond-spins/wheel-v4-live-definitions.json';
import {
  WHEEL_V4_FOLLOW,
  WHEEL_V4_GAME_BY_ORD,
  WHEEL_V4_GAME_ORDS,
  WHEEL_V4_TOTAL,
  WHEEL_V4_UPGRADE_ORD_BY_GAME,
  WHEEL_V4_UPGRADE_WEIGHTS,
  WHEEL_V4_WEIGHTS,
} from '../../src/utils/wheelV4Model';
import { diamondBonusFloor } from '../../src/utils/diamondBonusPayout';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
const { default: service, WHEEL_DRAW_DOMAINS } =
  await import('../../src/services/DiamondWheelService');

type Body = { md5: string; length: number; src: string };
const tables = live.tables as unknown as Record<string, Body>;
const doors = live.doors as unknown as Record<
  string,
  { md5: string; length: number; contract_lines: string[] }
>;
const body = (name: string) => tables[name].src;

/** The rows of one `(VALUES ...)` list, as the SQL wrote them. */
function values(sql: string): string[][] {
  const rows: string[][] = [];
  for (const line of sql.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('(')) continue;
    const depth = text.indexOf(')');
    if (depth < 0) continue;
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (const ch of text.slice(1)) {
      if (ch === "'") quoted = !quoted;
      if (!quoted && ch === ',') {
        cells.push(cell.trim());
        cell = '';
        continue;
      }
      if (!quoted && ch === ')') break;
      cell += ch;
    }
    cells.push(cell.trim());
    rows.push(cells);
  }
  return rows;
}
const text = (cell: string) => (cell === 'NULL' ? null : cell.replace(/^'|'$/g, ''));
/** `2::numeric` and `2` are the same number to PostgreSQL and to this test. */
const num = (cell: string) => Number(cell.replace('::numeric', ''));

describe('the wheel v4 law the client holds is the law production runs', () => {
  it('captured every body byte-exact, as the database reported it', () => {
    for (const [name, captured] of Object.entries(tables)) {
      expect(captured.src).toHaveLength(captured.length);
      expect(`${name}: ${createHash('md5').update(captured.src).digest('hex')}`).toBe(
        `${name}: ${captured.md5}`
      );
    }
  });

  it('draws from the same twelve weights, and the same 0.8 payback', () => {
    const rows = values(body('fn_wheel_v4_model(boolean)'));
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => Number(r[0]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(rows.map((r) => Number(r[10]))).toEqual([...WHEEL_V4_WEIGHTS]);
    expect(WHEEL_V4_WEIGHTS.reduce((a, b) => a + b, 0)).toBe(WHEEL_V4_TOTAL);
    // The guard fn_wheel_spin_v2 runs before every draw: 100000 weight and
    // 480000 value-sixths is a payback of exactly 0.8, on both tables.
    for (const sixths of [5, 9] as const) {
      expect(rows.reduce((sum, r) => sum + Number(r[10]) * num(r[sixths]), 0)).toBe(480000);
    }
    // The four bonus segments, and the game each of them awards.
    const games = rows.filter((r) => text(r[2]) === 'bonus');
    expect(games.map((r) => Number(r[0]))).toEqual([...WHEEL_V4_GAME_ORDS]);
    expect(Object.fromEntries(games.map((r) => [Number(r[0]), text(r[3])]))).toEqual(
      WHEEL_V4_GAME_BY_ORD
    );
  });

  it('never offers a VIP an item: six chips, one diamonds, one upgrade, four games', () => {
    const rows = values(body('fn_wheel_v4_model(boolean)'));
    const vip = rows.map((r) => ({ label: text(r[6]), kind: text(r[7]), multiplier: num(r[8]) }));
    expect(vip).toHaveLength(12);
    const count = (kind: string) => vip.filter((s) => s.kind === kind).length;
    expect([count('chips'), count('diamonds'), count('upgrade'), count('bonus')]).toEqual([
      6, 1, 1, 4,
    ]);
    expect(vip.some((s) => ['throwables', 'time_bank', 'rabbit_hunt'].includes(s.kind ?? ''))).toBe(
      false
    );
    // The three item segments of the open table are the three that become chips.
    const open = rows.map((r) => text(r[2]));
    expect(rows.filter((r, i) => open[i] !== vip[i].kind).map((r) => text(r[2]))).toEqual([
      'throwables',
      'time_bank',
      'rabbit_hunt',
    ]);
    expect(vip.filter((s, i) => open[i] !== s.kind).map((s) => s.label)).toEqual([
      '0.2x Chips',
      '0.25x Chips',
      '0.3x Chips',
    ]);
  });

  it('follows one spin with the same matrix the server follows it with', () => {
    const rows = values(body('fn_wheel_v4_follow_model()'));
    expect(rows).toHaveLength(12);
    const matrix = rows.map((r) => r.slice(1).map(Number));
    expect(matrix).toEqual(WHEEL_V4_FOLLOW.map((row) => [...row]));
    matrix.forEach((row, i) => {
      expect(row[i]).toBe(0);
      expect(row.reduce((a, b) => a + b, 0)).toBe(WHEEL_V4_WEIGHTS[i]);
      row.forEach((weight, j) => expect(weight).toBe(matrix[j][i]));
    });
  });

  it('holds the same Upgrade table, in the same order', () => {
    const rows = values(body('fn_wheel_v3_upgrade_model()'));
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => Number(r[5]))).toEqual([...WHEEL_V4_UPGRADE_WEIGHTS]);
    const supers = rows.filter((r) => text(r[2]) === 'bonus');
    expect(Object.fromEntries(supers.map((r) => [text(r[3]) as string, Number(r[0])]))).toEqual(
      WHEEL_V4_UPGRADE_ORD_BY_GAME
    );
  });

  it('computes the bonus floor the way fn_diamond_bonus_floor computes it', () => {
    // The captured SQL, transcribed once and read back, so the formula under
    // test is the server's own and not a memory of it.
    expect(
      body('fn_diamond_bonus_floor(numeric,integer,integer,integer)').replace(/\s+/g, ' ')
    ).toBe(
      ' SELECT LEAST( CASE WHEN p_boost=2 THEN GREATEST(ceil(p_bet*50)/100,' +
        ' ceil(p_paid_diamonds::numeric*100/p_rate)/100) ELSE ceil(p_bet*50)/100 END,' +
        ' (ceil(p_bet*80)-1)/100) '
    );
    // PostgreSQL does this in exact numeric, so the mirror does it in cents.
    const server = (betCents: number, boost: 1 | 2, paid: number, rate: number) => {
      const half = Math.ceil(betCents / 2);
      const own = Math.ceil((paid * 100) / rate);
      return Math.min(boost === 2 ? Math.max(half, own) : half, Math.ceil((betCents * 8) / 10) - 1);
    };
    const disagreed: string[] = [];
    for (const rate of [100, 96, 125]) {
      for (let betCents = 25; betCents <= 12000; betCents += 37) {
        for (const boost of [1, 2] as const) {
          for (const paid of [0, 25, 100, 2500, 5000, 7500]) {
            const mine = Math.round(diamondBonusFloor(betCents / 100, boost, paid, rate) * 100);
            const theirs = server(betCents, boost, paid, rate);
            if (mine !== theirs)
              disagreed.push(
                `${betCents}c boost ${boost} paid ${paid} at ${rate}: ${mine} != ${theirs}`
              );
          }
        }
      }
    }
    expect(disagreed).toEqual([]);
  });

  it('accepts the contract the two doors are answering with, and nothing above it', async () => {
    const state = doors['fn_wheel_state_v2(p_club_id uuid, p_entry_diamonds integer)'];
    expect(state.contract_lines.every((line) => line.includes("'contract_version',4"))).toBe(true);
    expect(state.contract_lines.every((line) => line.includes("'model_version','wheel-v4'"))).toBe(
      true
    );
    const spin =
      doors[
        'fn_wheel_spin_v2(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_entry_diamonds integer, p_mode text, p_bonus_ticket_id uuid)'
      ];
    expect(spin.contract_lines[0]).toContain("'contract_version',4,'model','wheel-v4'");
    expect(spin.contract_lines[1]).toContain("'segment_version',4");
    expect(WHEEL_DRAW_DOMAINS).toContain('wheel-v4');
    expect(WHEEL_DRAW_DOMAINS).toContain('wheel-v4-upgrade');

    // The door itself: a v4 state is read, and an unknown contract is refused
    // rather than guessed at. This is the exact throw the live pages were
    // stuck on while the deployed client only knew 2 and 3.
    const answered = (contract: number) => ({
      data: {
        ok: true,
        contract_version: contract,
        model_version: 'wheel-v4',
        enabled: true,
        available: false,
        reason: 'not_configured',
      },
      error: null,
    });
    rpc.mockReset();
    rpc.mockResolvedValueOnce(answered(4));
    await expect(service.getStateV2('club', 100)).resolves.toMatchObject({
      contract_version: 4,
    });
    rpc.mockReset();
    rpc.mockResolvedValueOnce(answered(5));
    await expect(service.getStateV2('club', 100)).rejects.toThrow(
      'Diamond Spins Availability Could Not Be Confirmed'
    );
  });
});
