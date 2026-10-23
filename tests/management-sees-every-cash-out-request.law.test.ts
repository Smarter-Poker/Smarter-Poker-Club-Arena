/**
 * MANAGEMENT SEES EVERY CASH OUT REQUEST, AND IS NOT NOTIFIED OF IT
 * (Dan 2026-10-23, binding)
 *
 * "OWNERS, CO OWNERS OR ADMINS SHOULD BE ABLE TO SEE ALL CASH OUT REQUESTS AND
 * PULL THOSE CHIPS. THEY SHOULDN'T GET THE NOTIFICATION, BUT IF THEY GO TO A
 * PLAYERS ACCOUNT, THEY SHOULD BE ABLE TO SEE 'CASH OUT REQUESTED'. THERE
 * SHOULD BE AN ICON ON THE CASHIER THAT MANAGEMENT AND OWNERS CAN SEE, BELOW
 * THE CURRENT 'REQUEST CASH OUT'."
 *
 * Pins the four pieces: the cashier's management button sits after Request
 * Cash Out and is gated on owner/co-owner/admin; the roster flags a pending
 * request; the member record prints "Cash Out Requested" and carries the
 * approval (the pull); and a HOLD document's audience is the player and their
 * agent, never the club owner by default.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('management sees every cash out request', () => {
  const cashier = read('src/pages/CashierTradePage.tsx');

  it('puts the Cash Out Requests button directly below Request Cash Out, for management only', () => {
    const request = cashier.indexOf('<span className={styles.cashoutLabel}>Request Cash Out</span>');
    const queue = cashier.indexOf('<span className={styles.cashoutLabel}>Cash Out Requests</span>');
    expect(request).toBeGreaterThan(0);
    expect(queue).toBeGreaterThan(request);
    expect(cashier).toMatch(
      /const managementClaims = myRole === 'owner' \|\| myRole === 'co_owner' \|\| myRole === 'admin';/
    );
    expect(cashier).toContain('{managementClaims && roleResolved && (');
    expect(cashier).toContain('useClubPendingCashouts(clubUuid, roleResolved && managementClaims)');
  });

  it('opens the existing approval flow, which pulls the chips into the approver wallet', () => {
    expect(cashier).toMatch(/<AgentCashoutPanel\s+clubId=\{clubUuid\}/);
  });

  it('flags a waiting player in the cashier roster', () => {
    expect(cashier).toContain('pendingCashouts.playerIds.has(r.userId)');
    expect(cashier).toContain('Cash Out Requested');
  });

  it('prints Cash Out Requested on the member record with the pull beside it', () => {
    const member = read('src/pages/MemberManagementPage.tsx');
    expect(member).toContain('Cash Out Requested</span>');
    expect(member).toMatch(/<AgentCashoutPanel[\s\S]*?playerId=\{memberUuid\}/);
  });

  it('reads the server-scoped queue, never a client-side role filter', () => {
    const hook = read('src/hooks/useClubPendingCashouts.ts');
    expect(hook).toContain('getAgentPendingCashouts');
  });

  it('does not notify management of a request: the hold audience is the player and their agent', () => {
    const dir = join(root, 'supabase/migrations');
    const file = readdirSync(dir).find((f) =>
      f.endsWith('_a_cash_out_request_notifies_the_player_s_agent_not_managemen.sql')
    );
    expect(file).toBeTruthy();
    const sql = readFileSync(join(dir, file!), 'utf8');
    expect(sql).toContain(
      "CASE WHEN kind=''hold'' THEN ARRAY[r.player_id] ELSE ARRAY[club.owner_id,r.player_id] END"
    );
  });
});
