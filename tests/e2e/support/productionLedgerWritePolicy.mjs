// A production e2e run never writes a hand or ledger table.
//
// Every spec under tests/e2e that holds the service role runs against the
// deployed production database (post-deploy-e2e.yml). The settled-hand Daily
// Missions certification used to insert a synthetic hand_history row there
// (table_id NULL, winners [], pot 600) and delete it in a finally block; every
// run that was cancelled before its finally left a winnerless hand in the live
// ledger, and four of them tripped the cash-pot conservation monitor twelve
// times (board #5070, incident e2e-synthetic-hands).
//
// This module is the single source of truth for that rule. The service-role
// request layer (temporaryCustomizationAccount.ts serviceRequest) calls
// assertProductionLedgerWriteAllowed before every request, so a write is
// refused at run time whatever shape the spec used to build it, and
// tests/operations/production-e2e-ledger-write-guard.test.mjs scans the specs
// with the same lists on every pull request.

// Hand history and everything derived from it, and every chip, diamond, rake,
// jackpot, seat and settlement ledger. A production spec may read these; it
// may never write them.
export const LEDGER_TABLES = new Set([
  'hand_history',
  'hand_atomic_commits',
  'hand_projection_outbox',
  'ca_hand_player_idx',
  'ca_hand_financial_facts',
  'bomb_pot_award_units',
  'rake_records',
  'rake_attributions',
  'accounting_cash_accrual_batches',
  'chip_ledger',
  'chip_transactions',
  'wallets',
  'wallet_transactions',
  'diamond_wallets',
  'diamond_transactions',
  'bbj_payouts',
  'bbj_contributions',
  'table_seats',
  'tournament_payouts',
  'tournament_terminal_settlements',
  'financial_alerts',
]);

// An RPC that commits, settles, projects, repairs or prunes a hand, or moves
// rake, jackpot, payout or seat state. The diamond fixture RPCs a certification
// account needs (fn_ca_mint, fn_ca_burn, add_diamonds_to_balance,
// deduct_diamonds) and the guarded fixture cleanup do not match.
export const HAND_LEDGER_RPC =
  /(?:^|_)(?:hand|hands|rake|settle|settlement|payout|payouts|jackpot|bbj|seat|seats)(?:_|$)/;

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Throws before a service-role request that would write a hand or ledger
 * table, or call a hand, rake, settlement, payout, jackpot or seat RPC.
 *
 * @param {{ method?: string, path: string, body?: unknown }} request
 */
export function assertProductionLedgerWriteAllowed({ method = 'GET', path, body }) {
  const verb = String(method).toUpperCase();
  if (READ_METHODS.has(verb)) return;
  const pathname = String(path).split('?')[0];

  const rpc = /^\/rest\/v1\/rpc\/([^/]+)$/.exec(pathname);
  if (rpc) {
    const name = decodeURIComponent(rpc[1]).toLowerCase();
    if (HAND_LEDGER_RPC.test(name)) {
      throw new Error(
        `Refused: a production e2e run may not call ${name}. Certify hand, rake, settlement, ` +
          'payout, jackpot and seat behavior on a native PostgreSQL fixture (scripts/ci/test-*-postgres.py).'
      );
    }
    return;
  }

  const rest = /^\/rest\/v1\/([^/]+)$/.exec(pathname);
  if (!rest) return;
  const table = decodeURIComponent(rest[1]).toLowerCase();
  if (!LEDGER_TABLES.has(table)) return;
  throw new Error(
    `Refused: a production e2e run may not ${verb} ${table}. Production specs read hand and ledger ` +
      'tables; they never write them. Certify the database behavior on a native PostgreSQL fixture.'
  );
}
