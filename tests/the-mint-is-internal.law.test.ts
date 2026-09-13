import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * THE MINT IS INTERNAL (Dan, 2026-09-05, BINDING)
 *
 * Dan, verbatim: "THEY SHOULD NEVER SEE OF HAVE ACCESS TO THE MINT, THATS
 * INTERNAL SYSTEMS."
 *
 * WHY THIS LAW EXISTS, and it is not a hypothetical risk.
 *
 * On 2026-09-05 I audited the wallet and reported to Dan that "the Mint is
 * invisible to players" as a GAP - and offered to show diamond provenance per
 * row so a player could see that a diamond came from a purchase, a reward or a
 * promo. Dan's answer was the sentence above. The proposal was wrong, it was
 * mine, and the next agent auditing this page will reach for the same idea for
 * the same reason: the register knows the origin, the ledger row does not show
 * it, and that looks like something missing. It is not missing. It is
 * deliberately internal.
 *
 * WHAT IS ACTUALLY TRUE TODAY, measured rather than assumed (2026-09-05):
 *
 *   Database    RLS on ca_mint_ledger and ca_mint_policy gates SELECT on
 *               profiles.role IN ('admin','god','superadmin'). Probed by
 *               impersonating a real non-admin through request.jwt.claims:
 *               a PLAYER sees 0 mint rows and 0 policy rows, an ADMIN sees
 *               3,157 - so the policy restricts rather than merely blocking.
 *   Club Arena  Zero reads of every diamond-Mint identifier anywhere in src/.
 *   World Hub   Only /horses, a staff page: a non-operator is refused with
 *               "Access Denied. Operator Privileges Are Required." and is
 *               signed out rather than left holding a session there.
 *
 * This law defends the middle line - the PLAYER APP. The database half is
 * pinned from the migration text below; the World Hub half belongs to that
 * repo's own gate.
 *
 * WHAT THIS LAW DOES NOT BAN. The word "mint" is legitimate here for CHIPS: a
 * club owner mints chips into a club treasury (ChipMintModal, mint_club_chips,
 * fn_mint_club_chips) and those flows are player-visible on purpose. Only the
 * DIAMOND Mint - the register itself - is internal, so this pins the exact
 * identifiers rather than the word.
 */

const ROOT = resolve(__dirname, '..');

/** The register and its readers. Naming these, never the word "mint". */
const DIAMOND_MINT_IDENTIFIERS = [
  'ca_mint_ledger',
  'ca_mint_policy',
  'ca_diamond_house',
  'fn_ca_mint_overview',
  'fn_ca_diamond_register_vs_supply',
];

const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
    }
  };
  walk(join(ROOT, 'src'));
  return out;
};

describe('the player app never reads the diamond Mint', () => {
  const files = sourceFiles();

  it.each(DIAMOND_MINT_IDENTIFIERS)('no source file references %s', (identifier) => {
    const offenders = files
      .filter((f) => readFileSync(f, 'utf8').includes(identifier))
      .map((f) => relative(ROOT, f));
    expect(
      offenders,
      `${identifier} is internal. If a player genuinely needs a number derived ` +
        `from it, the answer is a server-side aggregate that does not name the ` +
        `register - never a client read.`
    ).toEqual([]);
  });

  it('the wallet shows a diamond ledger, never where the diamond was minted', () => {
    // The wallet reads `diamond_transactions` - the player's OWN journal, which
    // is theirs to see. It must not reach past that into the register that
    // records what the house issued and retired.
    //
    // The read moved out of the page and into useDiamondLedger on 2026-09-05,
    // when the Receive and Send panes became two directions of one paged query.
    // The pin follows the mechanism; both files are held, so putting the read
    // back in the page does not escape it either.
    const wallet = readFileSync(join(ROOT, 'src/pages/PlayerWalletPage.tsx'), 'utf8');
    const ledger = readFileSync(join(ROOT, 'src/hooks/useDiamondLedger.ts'), 'utf8');
    expect(ledger).toContain(".from('diamond_transactions')");
    for (const identifier of DIAMOND_MINT_IDENTIFIERS) {
      expect(ledger, `the diamond ledger must not read ${identifier}`).not.toContain(identifier);
      expect(wallet, `the wallet must not read ${identifier}`).not.toContain(identifier);
    }
  });
});

describe('and the database refuses a player even if a client asks', () => {
  const MIGRATION = readFileSync(
    join(ROOT, 'supabase/migrations/20260902172915_the_mint_issuance_and_retirement.sql'),
    'utf8'
  );

  it('the register is readable only by an admin role', () => {
    // Defence in depth: the law above is the client half. This is why a client
    // read would fail anyway - and why removing this policy is the more serious
    // regression of the two.
    expect(MIGRATION).toContain('CREATE POLICY ca_mint_ledger_admin_read ON public.ca_mint_ledger');
    expect(MIGRATION).toMatch(
      /ca_mint_ledger_admin_read[\s\S]*?p\.role IN \('admin', 'god', 'superadmin'\)/
    );
  });

  it('anon holds nothing on the register at all', () => {
    expect(MIGRATION).toContain('REVOKE ALL ON public.ca_mint_ledger FROM anon, authenticated;');
    // SELECT is handed back only to `authenticated`, where the policy above is
    // what actually decides. `anon` never gets it back.
    expect(MIGRATION).toContain('GRANT SELECT ON public.ca_mint_ledger TO authenticated;');
    expect(MIGRATION).not.toMatch(/GRANT[^;]*ON public\.ca_mint_ledger TO[^;]*anon/);
  });
});
