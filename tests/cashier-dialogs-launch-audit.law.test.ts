import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * CLUB ARENA CASHIER LAUNCH AUDIT, DIALOGS AND WALLET ENTRY SURFACES
 * (2026-10-09). Every finding in the dialogs slice (D-01..D-24), the render
 * slice items on these surfaces (R-01..R-05, R-07, R-09, R-13) and the two
 * service findings that land in a dialog (S-04, S-07) is pinned here at its
 * source, so the regression is a red test before it is a render.
 *
 * The behavioural halves live beside each component's own test; this file
 * reads the source and the stylesheets and refuses the exact shapes the
 * audit found.
 */

const read = (path: string) => readFileSync(path, 'utf8');

const WCM = 'src/components/wallet/WalletCashierModal.tsx';
const PWM = 'src/components/wallet/PlayerWalletModal.tsx';
const MINT = 'src/components/wallet/ChipMintModal.tsx';
const UWM = 'src/components/union/UnionWalletModal.tsx';
const DWM = 'src/components/wallet/DiamondWalletModal.tsx';
const DWM_CSS = 'src/components/wallet/DiamondWalletModal.css';
const DWT = 'src/components/wallet/DiamondWalletTransfer.tsx';
const DW = 'src/components/wallet/DynamicWallet.tsx';
const DW_CSS = 'src/components/wallet/DynamicWallet.css';
const STATEMENT = 'src/components/wallet/ChipStatement.tsx';
const TILE = 'src/components/home/ClubQuickLinkTile.tsx';
const TABLE = 'src/components/table/CashierModal.tsx';
const TABLE_CSS = 'src/components/table/CashierModal.css';
const PURCHASE = 'src/components/table/PurchaseConsole.tsx';
const ADDON_CSS = 'src/components/table/AddOnModal.css';
const AGENT = 'src/components/agent/AgentCashoutPanel.tsx';
const CASHOUT = 'src/components/wallet/CashoutRequestModal.tsx';

const count = (source: string, pattern: RegExp) => (source.match(pattern) ?? []).length;

/** Every `<SpadeConsole` opening tag, brace-aware (same reader as the console law). */
const consoleTags = (source: string): string[] => {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('<SpadeConsole', from);
    if (start < 0) return tags;
    let depth = 0;
    let end = -1;
    for (let i = start + '<SpadeConsole'.length; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0 && source[i - 1] !== '=') {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error(`unterminated <SpadeConsole at ${start}`);
    tags.push(source.slice(start, end + 1));
    from = end + 1;
  }
};

/** One CSS rule's declarations, by selector text (first match). */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};

describe('D-01 / D-02: the Club Bank cashier cannot be closed out from under money', () => {
  const src = read(WCM);

  it('Escape is ignored while the mint is stacked above the cashier', () => {
    expect(src).toContain('const showMintRef = useRef(false);');
    expect(src).toContain(
      "if (e.key !== 'Escape' || busyRef.current || showMintRef.current) return;"
    );
    expect(src).not.toContain("if (e.key === 'Escape' && !busyRef.current) onClose();");
  });

  it('the painted corner X goes through closeIfIdle and is absent while in flight', () => {
    expect(src).toContain('onClose={inFlight ? undefined : closeIfIdle}');
    expect(src).not.toMatch(/<SpadeConsole\s+onClose=\{onClose\}\s+as="div"\s+\/\* The club/);
    expect(src).not.toContain('The corner X is gone');
  });
});

describe('D-03 / D-04: nothing from the previous club or the previous claim survives', () => {
  const src = read(WCM);
  const openEffect = src.slice(src.indexOf('// ── Open / reset'), src.indexOf('// Escape closes'));

  it('the open effect clears the club name, every ledger figure and the countdown anchor', () => {
    for (const call of [
      "setClubName('')",
      'setLedgerTotal(0)',
      'setLedgerTotals(null)',
      'setLedgerTypes([])',
      'setLedgerError(null)',
      'setPromoLedgerTotal(0)',
      'setPromoLedgerTotals(null)',
      'setReversibleAnchor(null)',
    ]) {
      expect(openEffect, call).toContain(call);
    }
  });

  it('the chosen recipient is re-read from the refreshed roster', () => {
    expect(src).toMatch(
      /setRecipient\(\(prev\) =>\s*prev \? \(mapped\.find\(\(m\) => m\.user_id === prev\.user_id\) \?\? null\) : prev\s*\)/
    );
    expect(src).toContain('const [holderNonce, setHolderNonce] = useState(0);');
    expect(src).toContain('setHolderNonce((n) => n + 1);');
    expect(src).toContain('[tab, destination, recipient, clubUuid, isMounted, holderNonce]');
  });
});

describe('D-05 / D-06: a late statement never paints under the next heading', () => {
  it('PlayerWalletModal sequences its reads and bumps the sequence on open', () => {
    const src = read(PWM);
    expect(src).toContain('const seqRef = useRef(0);');
    expect(src).toContain('const seq = ++seqRef.current;');
    expect(src).toContain('const current = () => isMounted.current && seq === seqRef.current;');
    expect(src).not.toContain('if (!isMounted.current) return;');
    expect(src).toMatch(/\+\+seqRef\.current;\s*setRows\(\[\]\);/);
  });

  it('UnionWalletModal guards its ledger and resets the count', () => {
    const src = read(UWM);
    expect(src).toContain('const ledgerSeq = useRef(0);');
    expect(src).toContain('const seq = ++ledgerSeq.current;');
    expect(src).toContain('if (!current()) return;');
    expect(src).toContain("if (current()) setLedgerError('Could Not Load The Ledger.');");
    expect(src).toContain('if (current()) setLedgerLoading(false);');
    expect(src).toMatch(/setLedger\(\[\]\);\s*setLedgerTotal\(0\);/);
  });
});

describe('D-07 / D-15: every amount is read from its spelling, not from Number()', () => {
  it('UnionWalletModal refuses sub-cent, exponent and over-balance member sends', () => {
    const src = read(UWM);
    expect(src).toContain('const CENT_AMOUNT = /^\\d+(\\.\\d{1,2})?$/;');
    expect(src).toContain('const WHOLE_AMOUNT = /^\\d+$/;');
    expect(src).toMatch(
      /if \(mode === 'send' && amt > liveBalance\)\s*return `This Wallet Only Holds/
    );
    expect(src).toContain('Boolean(amountRefusal) ||');
    expect(src).toMatch(
      /if \(amountRefusal\) \{\s*setNotice\(\{ ok: false, text: amountRefusal \}\);\s*return;/
    );
    // The "would hold" sentence only prints for an amount the send accepts.
    expect(src).toContain('{Number(amount) > 0 && target && !amountRefusal && (');
  });

  it('whole-unit amounts are digits only on the cashier, the mint and the diamond transfer', () => {
    expect(read(WCM)).toContain('const WHOLE_CHIPS = /^\\d+$/;');
    expect(read(WCM)).toContain('WHOLE_CHIPS.test(amount.trim())');
    expect(read(MINT)).toContain('const WHOLE_DIAMONDS = /^\\d+$/;');
    expect(read(MINT)).toContain('const spelledWhole = WHOLE_DIAMONDS.test(diamonds.trim());');
    expect(read(MINT)).toMatch(/const valid =\s*d > 0 && spelledWhole &&/);
    expect(read(DWT)).toContain('const WHOLE_DIAMONDS = /^\\d+$/;');
    expect(read(DWT)).toContain('!WHOLE_DIAMONDS.test(spelled) ||');
  });
});

describe('D-08 / R-02: the riveted statement never shows an empty plate', () => {
  it('every riveted console in ChipStatement carries both labelled plates', () => {
    const src = read(STATEMENT);
    const tags = consoleTags(src);
    expect(tags.length).toBeGreaterThanOrEqual(6);
    for (const tag of tags) {
      expect(tag).toContain('family="riveted"');
      expect(tag).toMatch(/\bplates=\{/);
      expect(tag).not.toMatch(/foot=["']foot["']/);
    }
    expect(src).toContain('function statementPlates(');
    expect(src).toMatch(/secondary: \{\s*label: opts\.refreshLabel \?\? 'Refresh'/);
    expect(src).toContain("? 'Load Earlier Movements'");
    expect(src).toContain(": 'Up To Date'");
    expect(src).not.toContain('chip-statement__btn');
  });
});

describe('D-09 / R-05 / D-10 / D-22: the in-table cashier', () => {
  it('draws the cash chassis at its own 1010 x 1557 ratio with 44px plates at 375px', () => {
    const css = read(ADDON_CSS);
    expect(rule(css, '.purchase-console__cash')).toContain('aspect-ratio: 1010 / 1557');
    const plate = rule(css, '.purchase-console__cash .addon-console__plate');
    const close = rule(css, '.purchase-console__cash .addon-console__close');
    const pct = (block: string) => Number(/height:\s*([\d.]+)%/.exec(block)?.[1]);
    // 375px viewport less the 16px overlay padding each side: a 343px canvas.
    const canvasHeight = (343 * 1557) / 1010;
    expect((pct(plate) / 100) * canvasHeight).toBeGreaterThanOrEqual(44);
    expect((pct(close) / 100) * canvasHeight).toBeGreaterThanOrEqual(44);
    const presets = rule(css, '.purchase-console__presets');
    expect((pct(presets) / 100) * canvasHeight).toBeGreaterThanOrEqual(44);
  });

  it('prints its refusal inside the painted frame and never on bare black below it', () => {
    const src = read(TABLE);
    expect(src).not.toContain('messages={');
    expect(src).not.toContain('cashier-recent');
    expect(src).toContain('const statusLine = submitError ? (');
    expect(src).toContain('{statusLine}');
    expect(read(PURCHASE)).toContain('{messages !== undefined && (');
    expect(read(TABLE_CSS)).not.toContain('.cashier-recent');
    expect(read(TABLE_CSS)).not.toContain('.cashier-rows');
    expect(read(TABLE_CSS)).not.toContain('.cashier-quick__word');
  });

  it('never claims nothing moved on a thrown transport failure', () => {
    expect(read(TABLE)).not.toContain('Nothing Was Moved');
  });

  it('says when it clamps and can mark the amount invalid', () => {
    const src = read(TABLE);
    expect(src).toContain("const [amountText, setAmountText] = useState('');");
    expect(src).toContain('onBlur={clampOnBlur}');
    expect(src).toContain("aria-invalid={amountText.trim() !== '' && !isValidAmount}");
    expect(src).toContain('setCapNote(`Capped At ${formatAmount(clamped)}`);');
    expect(src).not.toContain('onChange={(e) => setAmount(clampToCents(');
    expect(src).not.toContain('visibleQuick');
    expect(src).toContain('<span role="status">Balance Unavailable</span>');
  });
});

describe('D-11: focus is trapped, moved in and returned on every money dialog', () => {
  it.each([WCM, PWM, MINT, UWM])('%s uses the shared focus trap on its panel', (path) => {
    const src = read(path);
    expect(src).toContain("import { useFocusTrap } from '../../hooks/useFocusTrap';");
    expect(src).toMatch(/const panelRef = useFocusTrap<HTMLDivElement>\(/);
    expect(src).toContain('ref={panelRef}');
  });

  it('the cashier keeps its trap under the stacked mint (G-05), and the union sheet locks scroll', () => {
    expect(read(WCM)).toContain('const panelRef = useFocusTrap<HTMLDivElement>(isOpen);');
    expect(read(WCM)).not.toContain('useFocusTrap<HTMLDivElement>(isOpen && !showMint)');
    const trap = read('src/hooks/useFocusTrap.ts');
    expect(trap).toContain(
      'if (activeTraps[activeTraps.length - 1] !== trapIdRef.current) return;'
    );
    expect(trap).toContain('activeTraps.push(trapId);');
    expect(read(MINT)).toContain("useFocusTrap<HTMLDivElement>(isOpen, '.cmm-input')");
    const union = read(UWM);
    expect(union).toContain("document.body.style.overflow = 'hidden';");
    expect(union).toContain('document.body.style.overflow = prevOverflow;');
  });
});

describe('D-12 (kept flat, see below) / D-13 / R-04: the Diamond Wallet', () => {
  it('asks for the flat crest and no other (the Marketplace dress, #4805)', () => {
    for (const tag of consoleTags(read(DWM))) {
      expect(tag).toContain('crest="flat"');
      expect(tag).not.toMatch(/\bcrest=(?!["']flat["'])/);
    }
  });

  it('holds every close path shut while a transfer is travelling', () => {
    const src = read(DWM);
    expect(src).toContain('const [transferBusy, setTransferBusy] = useState(false);');
    expect(src).toContain('onClose={transferBusy ? undefined : closeIfIdle}');
    expect(src).toContain('onClick={closeIfIdle} role="presentation"');
    expect(src).toContain('if (!transferBusyRef.current) onCloseRef.current();');
    expect(src).toMatch(/secondary: \{\s*label: 'Close',[\s\S]*?disabled: transferBusy,/);
    expect(src).toContain('onBusyChange={onTransferBusyChange}');
    expect(read(DWT)).toContain('onBusyChange?: (busy: boolean) => void;');
    expect(read(DWT)).toContain('setSending(true);');
  });

  it('dresses Retry Balance as a word control, not a raw grey button', () => {
    const css = read(DWM_CSS);
    const retry = rule(css, '.diamond-wallet-modal__custody-balances button');
    expect(retry).toContain('background: transparent');
    expect(retry).toContain('border: 0');
    expect(retry).toContain("'Roboto Condensed'");
    expect(css).toContain("[role='dialog'] .diamond-wallet-modal__custody-balances button,");
  });
});

describe('D-14 / R-01: the Cashier card directory on the shark master', () => {
  it('labels the one painted plate and fills the pill slot', () => {
    const tile = read(TILE);
    const [tag] = consoleTags(tile);
    expect(tag).toContain('family="shark"');
    expect(tag).toMatch(/plates=\{\{\s*primary: \{\s*label: 'Close'/);
    expect(tag).toContain('pill="Wallets"');
    // The 2026-10-03 ruling stands: no invented mark for a club without a logo,
    // but the slot is kept so every name starts on the same line.
    expect(tile).not.toContain('cashierSwitchLogoFallback');
    expect(tile).toContain('<span className={styles.cashierSwitchLogo} aria-hidden="true" />');
  });
});

describe('R-03 / R-07 / R-13: DynamicWallet', () => {
  it('prints "-" for every figure when the first read fails', () => {
    const src = read(DW);
    expect(src).toContain('const [everRead, setEverRead] = useState(() => Boolean(boot.entry));');
    expect(src).toContain('const figuresUnknown = fetchError && !everRead;');
    expect(src).toContain('if (figuresUnknown) return null;');
    expect(src).toContain("{figuresUnknown ? '-' : formatDiamonds(animDiamonds)}");
    expect(src).toContain(
      "{row.known === false || figuresUnknown ? '-' : formatBalance(row.value)}"
    );
    expect(src).toContain("settled === null ? 'Unavailable' : formatBalance(settled)");
    expect(src).not.toContain("'unavailable'");
    expect(src).not.toContain('console.warn');
  });

  it('draws no radius or gradient on the rules that render, and ratchets the legacy rest', () => {
    const css = read(DW_CSS);
    for (const selector of [
      '.dw__shimmer',
      '.dw__shimmer--bbj',
      '.dw__shimmer--row',
      '.dw__error-badge',
    ]) {
      const block = rule(css, selector);
      expect(block, selector).not.toMatch(/border-radius:\s*[1-9]/);
      expect(block, selector).not.toMatch(/gradient\(/);
    }
    expect(css).not.toContain('.dw__error-badge::before');
    /* What remains is the pre-art chassis: `.dw__bbj`, `.dw__bbj::after`,
       `.dw__bbj-label`, `.dw__bbj-amount`, `.dw__row`, `.dw__row--actionable`,
       `.dw__plus`, `.dw--union .dw__bbj-label` and `.dw--lobby-board .dw__row`.
       Every row and the banner carry the wallet-art classes whose later rules
       set radius 0 and a transparent background, the labels are visually
       hidden and the plus is an invisible hotspot, so none of these paint.
       They stay referenced by the TSX, so they are pinned by exact count
       rather than deleted: the numbers may only fall. */
    expect(count(css, /border-radius:\s*(?:50%|[1-9])/g)).toBe(5);
    expect(count(css, /gradient\(/g)).toBe(7);
  });
});

describe('S-04 / S-07: the dialogs trust neither a note nor a table read', () => {
  it('the cashier CSV goes through statementCsvCell with the statement export convention', () => {
    const src = read(WCM);
    expect(src).toContain("import { statementCsvCell } from '../../utils/cashierStatementCsv';");
    expect(src).not.toMatch(/function csvCell\(/);
    expect(src).not.toContain('.map(csvCell)');
    expect(src).toContain("const csvText = (v: unknown) => statementCsvCell(v, 'text');");
    expect(src).toContain("const csvDecimal = (v: unknown) => statementCsvCell(v, 'decimal');");
    expect(src).toContain("const csvTimestamp = (v: unknown) => statementCsvCell(v, 'timestamp');");
    expect(src).toContain(
      "'\\ufeff' + [header.map(csvText).join(','), ...body].join('\\r\\n') + '\\r\\n'"
    );
    expect(src).toContain('csvText(r.notes ?? ???)'.replace('???', "''"));
  });

  it('the mint pre-flight reads the club through fn_club_money_panel and fails closed', () => {
    const src = read(MINT);
    expect(src).toContain("await supabase.rpc('fn_club_money_panel', {");
    expect(src).not.toContain(".from('clubs')");
    expect(src).not.toContain(".from('union_admins')");
    expect(src).toContain(
      "setTarget({ state: 'denied', label: 'Mint Rights Could Not Be Checked' });"
    );
    expect(src).toContain('if (panel.authorized !== true) {');
    expect(src).toContain("const mayMint = panel.scope === 'union';");
    expect(src).toContain("if (panel.scope !== 'club') {");
    // The RPC is still the authority: nothing here changed what it is told.
    expect(src).toContain("await supabase.rpc('fn_mint_chips_from_diamonds', {");
  });

  /**
   * S-07 FOLLOW-UP (2026-10-10). Club Bank (`clubs.chip_treasury`) and the
   * club promo pot (`clubs.promo_balance`) are readable by every API caller
   * (table-level SELECT to anon and authenticated), and a column REVOKE is
   * deferred because PostgREST answers `select=*` with 42501 the moment a role
   * lacks SELECT on any one column. So the cashier and wallet surfaces must not
   * DEPEND on those columns: every figure comes through
   * `fn_club_money_panel`, the SECURITY DEFINER read with the server role
   * check, which answers Unavailable (never 0) when it refuses.
   *
   * This pin walks every `.from('clubs')` read on those surfaces and refuses
   * a column list that names either column, a `*`, or a bare `.select()`
   * (which is `*` to PostgREST). The club pages (`ClubHomePage`,
   * `ClubsService`) still read the column directly and are out of scope here.
   */
  it('no cashier or wallet surface selects chip_treasury or promo_balance off clubs', () => {
    const walletDir = 'src/components/wallet';
    const surfaces = [
      'src/pages/CashierPage.tsx',
      'src/services/WalletService.ts',
      'src/components/agent/ChipTransferModal.tsx',
      'src/components/agent/AgentPromoPanel.tsx',
      'src/components/union/UnionWalletModal.tsx',
      ...readdirSync(walletDir)
        .filter((name) => /\.tsx?$/.test(name))
        .map((name) => `${walletDir}/${name}`),
    ];
    expect(surfaces.length).toBeGreaterThan(10);
    for (const path of surfaces) {
      const src = read(path);
      const reads = [...src.matchAll(/\.from\(\s*['"]clubs['"]\s*\)\s*\.select\(([^)]*)\)/g)];
      for (const [whole, columns] of reads) {
        const list = columns.trim();
        expect(list, `${path}: ${whole}`).not.toBe('');
        expect(list, `${path}: ${whole}`).not.toMatch(/\*/);
        expect(list, `${path}: ${whole}`).not.toMatch(/chip_treasury|promo_balance/);
      }
    }
    // Every surface that shows the club's money reads it through the panel.
    expect(read('src/services/cashierBalanceRead.ts')).toContain(
      "supabase.rpc('fn_club_money_panel', { p_club_id: uuid })"
    );
    expect(read('src/components/agent/ChipTransferModal.tsx')).toContain(
      "await supabase.rpc('fn_club_money_panel', {"
    );
    expect(read(DW)).toContain(".rpc('fn_club_money_panel', { p_club_id: resolvedId })");
  });
});

describe('D-18 .. D-23: the low findings on the dialog slice', () => {
  it('no console.warn on a money surface; everything goes through reportError', () => {
    for (const path of [CASHOUT, AGENT, DW]) expect(read(path), path).not.toContain('console.warn');
  });

  it('words, not glyphs, and Title Case on what the data prints', () => {
    const agent = read(AGENT);
    for (const glyph of ['⚠', '↻', '◉']) expect(agent).not.toContain(glyph);
    expect(agent).toContain('titleCase(formatRelativeShort(cashout.createdAt))');
    expect(agent).not.toContain('generateDefaultAvatar');
    expect(agent).toContain("note: 'Request Declined',");
    expect(agent).not.toContain("'Request declined'");
    expect(read(CASHOUT)).toContain('titleCase(formatRelativeShort(cashout.createdAt))');
    const union = read(UWM);
    expect(union).not.toContain("'union send failed'");
    expect(union).not.toContain("'Clawback failed'");
    expect(read(WCM)).toContain('{Math.floor(left / 60)} Min {left % 60} Sec Left');
    expect(read(WCM)).not.toContain('}m {left % 60}s Left');
  });

  it('the refused cashier branch is a modal too', () => {
    expect(count(read(WCM), /aria-modal="true"/g)).toBe(2);
  });

  it('the agent desk tracks every card in flight, not the last one tapped', () => {
    const agent = read(AGENT);
    expect(agent).toContain('useState<ReadonlySet<string>>(() => new Set())');
    expect(agent).toContain('setProcessing((prev) => new Set(prev).add(cashout.id));');
    expect(agent).not.toContain('processing === cashout.id');
    expect(agent).not.toContain('setProcessing(null)');
  });

  it('the cashout sheet listens to this player and reloads for this club, resolved to a uuid first (G-02)', () => {
    const src = read(CASHOUT);
    expect(src).toContain("import { resolveClubUUID } from '../../utils/clubIdResolver';");
    expect(src).toContain('filter: `player_id=eq.${playerId}`,');
    expect(src).not.toContain('`club_id=eq.${resolved}`');
    expect(src).toContain('if (!resolved || rowClub === undefined || rowClub === resolved) {');
    expect(src).toContain('const resolved = clubId ? await resolveClubUUID(clubId) : null;');
  });
});
