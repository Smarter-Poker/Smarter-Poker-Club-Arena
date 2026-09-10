/**
 * PROMO IS OWNER MONEY, AND NOTHING ELSE PAYS IT.
 *
 * 2026-09-03, Dan (binding):
 *   - "WE'VE NEVER BUILT THE SPLASH POT YET, OR DESIGNED RULES FOR IT, ITS
 *     SUPPOSED TO BE ADDED LATER, ONCE WE WORK ALL THE BUGS OUT."
 *   - "PROMO DOESNT OWE ANYONE ANYTHING EVER... PROMO CHIPS ARE TREATED EXACTLY
 *     LIKE REGULAR CHIPS ALWAYS."
 *   - "WE SHOULDN'T NEED THOSE DETECTORS OR WATCH DOGS IF YOU FIX THIS ALL AND
 *     MAKE IT SO ITS IMPOSSIBLE TO EVER LOSE A CHIP."
 *
 * Five promo doors existed. One is sanctioned. The other four moved money that
 * was never funded, into buckets nobody could spend from:
 *
 *   fn_promo_disburse            SANCTIONED - owner to club or player, ordinary chips
 *   fn_bbj_promo_rain            the splash pot, never designed - shut
 *   add_to_promo_wallet          wrote wallets(PROMO), 10,700 chips no code reads
 *   distribute_promo_chips       read agents.promo_balance, 0.00 estate-wide
 *   transfer_promo_club_to_agent credited a locked bucket ruling 4B abolishes
 *
 * The phantom pool came from create_user_wallets, an orphaned signup function
 * handing every account a 100-chip welcome bonus into a table the chip supply
 * has never counted. Retired as a write-off and NOT as a burn: those chips
 * never entered circulation, so a burn row would have invented 10,700 of
 * issuance error in the accounts this programme exists to make exact.
 *
 * The rules this pins:
 *
 *   - the splash pot refuses and is unreachable from a browser until designed;
 *   - all four unfunded doors refuse and name fn_promo_disburse;
 *   - the phantom pool is zeroed, its rows kept (40 legacy escrow holds still
 *     reference them), and chip_ledger untouched;
 *   - the wallet-balance guard is opened by name for one statement and closed;
 *   - the app calls the owner door, not the retired agent one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const DIR = resolve(ROOT, 'supabase/migrations');
function read(fragment: string): string {
  const f = readdirSync(DIR)
    .filter((x) => x.includes(fragment))
    .sort()
    .pop();
  expect(f, `the migration containing "${fragment}" is missing`).toBeTruthy();
  return readFileSync(resolve(DIR, f as string), 'utf8');
}
const SPLASH = read('the_splash_pot_is_not_designed_yet');
const PHANTOM = read('the_phantom_promo_pool_is_retired');
const WALLET_SVC = readFileSync(resolve(ROOT, 'src/services/WalletService.ts'), 'utf8');
const AGENT_PAGE = readFileSync(resolve(ROOT, 'src/pages/AgentDashboardPage.tsx'), 'utf8');
/* PlayerSessionsPage.tsx was de-routed on 2026-08-31 (App.tsx redirects
   /player-sessions to clubs/:clubId/members) and deleted on 2026-09-10 (audit
   CL-56); nothing imported it, so its promo button reached nobody. The pins
   below that read it now read the one page that still disburses promo chips.
   A page that no longer exists cannot call the retired path, which is what
   "leaves no page calling the retired path" asserts. */
const PROMO_PAGES = [AGENT_PAGE];

describe('the splash pot is shut until it is designed', () => {
  it('refuses every call and says why', () => {
    expect(SPLASH).toContain("'error', 'not_built_yet'");
    expect(SPLASH).toContain('The splash pot has not been designed');
    expect(SPLASH).toContain('fn_promo_disburse');
  });

  it('is unreachable from a browser', () => {
    expect(SPLASH).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_bbj_promo_rain\(uuid, numeric, text\)\s*FROM PUBLIC, anon, authenticated;/
    );
    expect(SPLASH).toContain('SPLASH_POT_SELFCHECK: a browser role can still reach the rain');
  });
});

describe('the phantom promo pool is retired, not burned', () => {
  it('zeroes the balances and never writes a burn row', () => {
    expect(PHANTOM).toContain('SET balance = 0, locked_balance = 0');
    expect(PHANTOM).not.toMatch(/fn_ca_declare_ledger\(\s*'burn'/);
    expect(PHANTOM).toContain("'ledger_touched', false");
  });

  it('keeps the rows because legacy escrow holds still point at them', () => {
    expect(PHANTOM).toContain("'rows_deleted', false");
    expect(PHANTOM).toContain('chip_escrow_holds');
  });

  it('refuses to run if anything ever starts reading the pool', () => {
    expect(PHANTOM).toContain(
      'something now reads wallets(PROMO); this retirement is no longer safe'
    );
  });

  it('opens the wallet guard by name for one statement and closes it', () => {
    expect(PHANTOM).toMatch(/set_config\('app\.bypass_wallet_guard', 'on', true\)/);
    expect(PHANTOM).toMatch(/set_config\('app\.bypass_wallet_guard', '', true\)/);
    expect(PHANTOM).toContain('PHANTOM_PROMO_SELFCHECK: the wallet guard was left open');
  });

  it('shuts all four unfunded doors and names the sanctioned one', () => {
    for (const fn of [
      'add_to_promo_wallet',
      'distribute_promo_chips',
      'transfer_promo_club_to_agent',
      'create_user_wallets',
    ]) {
      expect(PHANTOM).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
    }
    expect(PHANTOM).toContain('add_to_promo_wallet is retired');
    expect(PHANTOM).toContain('distribute_promo_chips is retired');
    expect((PHANTOM.match(/fn_promo_disburse/g) || []).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the app calls the owner door', () => {
  it('disburses through fn_promo_disburse, resolving the float owner', () => {
    expect(WALLET_SVC).toContain("supabase.rpc('fn_promo_disburse'");
    expect(WALLET_SVC).toContain("p_source_kind: club.union_id ? 'union' : 'club'");
    expect(WALLET_SVC).toContain('p_source_id: club.union_id ?? clubId');
  });

  it('retires the agent-keyed call rather than leaving it callable', () => {
    expect(WALLET_SVC).not.toContain("supabase.rpc('distribute_promo_chips'");
    expect(WALLET_SVC).toContain('distributePromo is retired');
  });

  it('leaves no page calling the retired path', () => {
    for (const page of PROMO_PAGES) {
      expect(page).not.toContain('WalletService.distributePromo(');
      expect(page).toContain('WalletService.disbursePromo(');
    }
  });

  it('drops the agent-PK lookup the retired path needed', () => {
    for (const page of PROMO_PAGES) {
      expect(page).not.toContain('Agent record not found for this club');
    }
  });
});
