/**
 * Union Dashboard club directory (2026-10-21).
 *
 * `clubs` carries column-level SELECT grants: its money columns
 * (chip_treasury, total_rake, promo_balance, ...) are withheld from browser
 * reads. PostgREST expands `*` - including an embedded `clubs:club_id(*)` - to
 * every column, withheld ones included, and fails the whole read with
 * "permission denied for table clubs". The Union Dashboard and the Union Bank
 * cashier both showed zero clubs because of that.
 *
 * So the page reads club identity here, and club money from
 * `fn_club_money_panel`, the SECURITY DEFINER read that checks union staff on
 * the server.
 */

/** Club columns the Union Dashboard reads. Never `*`. */
export const UNION_DASHBOARD_CLUB_COLUMNS = 'id, club_id, name, member_count, active_tables';

/** The money fields the panel supplies. */
export interface ClubMoney {
  chip_treasury?: number;
  total_rake?: number;
}

/** Fold an fn_club_money_panel answer into a club row. A refused or
 *  unreadable panel leaves the money fields undefined (shown as unknown),
 *  never a made-up 0. */
export function clubWithMoneyPanel<T extends Record<string, unknown>>(
  club: T,
  panel: unknown
): T & ClubMoney {
  if (!panel || typeof panel !== 'object') return club as T & ClubMoney;
  const p = panel as Record<string, unknown>;
  if (p.authorized !== true) return club as T & ClubMoney;
  const num = (v: unknown) => {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    ...club,
    chip_treasury: num(p.club_treasury),
    total_rake: num(p.club_rake_this_week),
  };
}
