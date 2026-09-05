/**
 * THE VIP ALL-IN SQUEEZE (Dan 2026-09-05), PINNED
 *
 * Dan, verbatim: "THIS FEATURE SHOULD ONLY BE PRESENTED AS AN OPTION AND
 * DISPLAYED ON 'ALL INS' (BEFORE THE RIVER OBVIOUSLY) AND SHOULD NEVER APPEAR
 * ON RUN IT 2X OR 3X. AND THIS SHOULD BE A VIP GATED PERK AND 'TURNED ON' BY
 * DEFAULT. IF A NONE VIP MEMBER TRIES TO TURN IT ON THEY SHOULD BE INSTRUCTED
 * THAT THEY NEED A VIP CARD TO USE THIS FEATURE. AND ONLY TO THE USERS THAT
 * ARE 'ALL IN' THE BOARD AND RUN OUT SHOULD APPEAR 'NORMAL' AND NO DIFFERENT
 * FOR ANY OTHER USERS AT THE TABLE."
 *
 * And, asked whether the board squeeze should be interactive like the
 * hole-card peel: yes, on every run-out card including the river.
 *
 * Run against the pre-feature tree (source stashed, the two new helper
 * modules left in place): 19 of the 31 pins failed there. The other twelve
 * pin invariants that were already true and must stay so - the spec mirror,
 * the 10.6 guarantees, the upsell copy rules, cancel hygiene - or exercise
 * the new pure helpers on their own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { CardPresentationEngine } from '../../src/presentation/cardPresentation/CardPresentationEngine';
import { CARD_PRESENTATION_PROFILES } from '../../src/presentation/cardPresentation/profiles';
import { resolveCardAnimationProfile } from '../../src/presentation/cardPresentation/resolveProfile';
import {
  viewerMaySqueeze,
  boardMaySqueeze,
  ALL_IN_SQUEEZE_VIP_REQUIRED_MESSAGE,
} from '../../src/presentation/cardPresentation/squeezeEligibility';
import { squeezeHostProps } from '../../src/presentation/cardPresentation/SqueezeCard';
import { ALL_IN_SQUEEZE_CEILING_MS, HAND_COMPLETION } from '../../src/config/handCompletionSpec';
import {
  DEFAULT_USER_TABLE_SETTINGS,
  TABLE_SETTINGS_META,
} from '../../src/hooks/useUserTableSettings';
import { effectiveSettingValue } from '../../src/components/table/TableSettingsPanel';
import {
  squeezeDragProgress,
  SQUEEZE_RELEASE_THRESHOLD,
} from '../../src/components/table/CommunityCards';
import { formatPopupText } from '../../src/utils/popupStyle';
import { useHeldValue } from '../../src/hooks/useHeldValue';
import type {
  CommunityCardDealPresentation,
  ResolveProfileInput,
} from '../../src/presentation/cardPresentation/types';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const P = CARD_PRESENTATION_PROFILES;

const base: ResolveProfileInput = {
  mode: 'cash',
  platform: 'mobile',
  focus: 'focused',
  reducedMotion: false,
  allIn: false,
};

describe('who may squeeze (R1, R2, R3, R4, R6, R8)', () => {
  const yes = {
    heroAllIn: true,
    isVip: true,
    settingOn: true,
    runItMultiple: false,
    bombPot: false,
  };
  it('an all-in VIP with the perk on, running it once', () => {
    expect(viewerMaySqueeze(yes)).toBe(true);
  });
  it('every clause is necessary on its own', () => {
    expect(viewerMaySqueeze({ ...yes, heroAllIn: false }), 'not all-in (R6)').toBe(false);
    expect(viewerMaySqueeze({ ...yes, isVip: false }), 'no VIP card (R3)').toBe(false);
    expect(viewerMaySqueeze({ ...yes, settingOn: false }), 'perk off (R8)').toBe(false);
    expect(viewerMaySqueeze({ ...yes, runItMultiple: true }), 'run it twice (R2)').toBe(false);
    // Dan 2026-09-05: "THIS ISN'T ALLOWED ON BOMB POTS OR ANY RUN IT 2 OR 3
    // TIMES RUN OUTS."
    expect(viewerMaySqueeze({ ...yes, bombPot: true }), 'bomb pot').toBe(false);
  });
  it('a re-run board or a second board never squeezes, whatever the viewer is owed', () => {
    expect(boardMaySqueeze(true, 1)).toBe(true);
    expect(boardMaySqueeze(true, undefined)).toBe(true);
    expect(boardMaySqueeze(true, 1, 0)).toBe(true);
    expect(boardMaySqueeze(true, 2)).toBe(false);
    expect(boardMaySqueeze(true, 3)).toBe(false);
    expect(boardMaySqueeze(true, 1, 1), 'bomb pot board 2').toBe(false);
    expect(boardMaySqueeze(true, 1, 2), 'bomb pot board 3').toBe(false);
    expect(boardMaySqueeze(false, 1)).toBe(false);
    expect(boardMaySqueeze(undefined, 1)).toBe(false);
  });
});

describe('the run-out looks NORMAL to everyone who is not squeezing (R7)', () => {
  it('an all-in runout without the squeeze right resolves the SAME profile as any other street', () => {
    for (const platform of ['mobile', 'tablet', 'desktop'] as const) {
      for (const mode of ['cash', 'tournament', 'spectator', 'replay'] as const) {
        for (const focus of ['focused', 'visible'] as const) {
          const ordinary = resolveCardAnimationProfile({ ...base, platform, mode, focus });
          expect(
            resolveCardAnimationProfile({ ...base, platform, mode, focus, allIn: true }),
            `${platform}/${mode}/${focus}: all-in, no squeeze right`
          ).toBe(ordinary);
          expect(
            resolveCardAnimationProfile({
              ...base,
              platform,
              mode,
              focus,
              allIn: true,
              squeeze: false,
            }),
            `${platform}/${mode}/${focus}: all-in, squeeze explicitly off`
          ).toBe(ordinary);
        }
      }
    }
  });
  it('the squeeze profile is chosen only when BOTH all-in and the right are true', () => {
    expect(resolveCardAnimationProfile({ ...base, allIn: true, squeeze: true })).toBe(P.allIn);
    expect(resolveCardAnimationProfile({ ...base, allIn: false, squeeze: true })).not.toBe(P.allIn);
  });
  it('nothing new is broadcast for it: the eligibility input is client-side only', () => {
    // The wire types the engine publishes carry no squeeze/VIP field. If one
    // appears, it is a tell (who is a VIP, who is squeezing) and a protocol
    // change; Dan asked for neither.
    const runout = read('server/src/engine/ServerTableEngineRunout.ts');
    expect(runout).not.toMatch(/squeeze/i);
    expect(runout).not.toMatch(/is_vip|isVip/);
  });
});

describe('the ceiling is derived from the server pacing, and the pacing is pinned', () => {
  it('ceiling = reveal gate + the shorter following pause - the snap reserve', () => {
    const H = HAND_COMPLETION;
    expect(ALL_IN_SQUEEZE_CEILING_MS).toBe(
      H.ALL_IN_STREET_REVEAL_MS +
        Math.min(H.ALL_IN_STREET_PAUSE_MS, H.ALL_IN_PRE_SHOWDOWN_PAUSE_MS) -
        H.ALL_IN_SQUEEZE_SNAP_RESERVE_MS
    );
    expect(ALL_IN_SQUEEZE_CEILING_MS).toBe(2550);
  });
  it('the spec copies of the two engine pauses equal the engine literals', () => {
    const runout = read('server/src/engine/ServerTableEngineRunout.ts');
    const street = Number(runout.match(/allInStreetPauseMs\s*=\s*(\d+)/)![1]);
    const pre = Number(runout.match(/allInPreShowdownPauseMs\s*=\s*(\d+)/)![1]);
    expect(street).toBe(HAND_COMPLETION.ALL_IN_STREET_PAUSE_MS);
    expect(pre).toBe(HAND_COMPLETION.ALL_IN_PRE_SHOWDOWN_PAUSE_MS);
  });
  it('the snap reserve is exactly what the all-in profile needs after the hold', () => {
    const p = P.allIn;
    expect(p.prepareMs + p.squeezeMs + p.revealMs + p.settleMs).toBe(
      HAND_COMPLETION.ALL_IN_SQUEEZE_SNAP_RESERVE_MS
    );
    expect(p.durationMs).toBe(ALL_IN_SQUEEZE_CEILING_MS);
  });
  it('the ceiling leaves the card face up before the next street or the pot can land', () => {
    const H = HAND_COMPLETION;
    expect(ALL_IN_SQUEEZE_CEILING_MS).toBeLessThan(
      H.ALL_IN_STREET_REVEAL_MS + H.ALL_IN_STREET_PAUSE_MS
    );
    expect(ALL_IN_SQUEEZE_CEILING_MS).toBeLessThan(
      H.ALL_IN_STREET_REVEAL_MS + H.ALL_IN_PRE_SHOWDOWN_PAUSE_MS
    );
  });
  it('the engine mirror of the spec is byte-identical', () => {
    expect(read('server/src/config/handCompletionSpec.ts')).toBe(
      read('src/config/handCompletionSpec.ts')
    );
  });
});

describe("the engine's hold is the player's (releaseHold)", () => {
  let now = 0;
  const river: CommunityCardDealPresentation = {
    tableId: 't1',
    handId: 7,
    boardIndex: 0,
    street: 'river',
    slotIndex: 4,
    sequence: 5,
  };
  const input: ResolveProfileInput = { ...base, allIn: true, squeeze: true };
  const build = (speed = 1) =>
    new CardPresentationEngine({ telemetry: () => {}, now: () => now, speed: () => speed });

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releasing during the hold runs squeeze -> reveal -> settle from that instant', () => {
    const e = build();
    const seen: Array<{ phase: string; at: number }> = [];
    e.subscribe((c) => seen.push({ phase: c.phase, at: now }));
    const r = e.presentCard(river, input);
    const p = r.profile;
    // 700ms in: still the player's.
    now += 700;
    vi.advanceTimersByTime(700);
    expect(e.phaseAt(r.key)).toBe('hold');
    expect(e.releaseHold(r.key)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ phase: 'squeeze', at: 1700 });
    expect(e.phaseAt(r.key)).toBe('squeeze');
    now += p.squeezeMs;
    vi.advanceTimersByTime(p.squeezeMs);
    expect(seen.find((s) => s.phase === 'reveal')).toMatchObject({ at: 1700 + p.squeezeMs });
    expect(e.phaseAt(r.key)).toBe('reveal');
    now += p.revealMs;
    vi.advanceTimersByTime(p.revealMs);
    expect(e.phaseAt(r.key)).toBe('settle');
    // And it completes on the re-based clock (settle + the 100ms mount
    // margin), long before the ceiling.
    const rest = p.settleMs + 100;
    now += rest;
    vi.advanceTimersByTime(rest);
    expect(e.isActive(r.key)).toBe(false);
    expect(seen.at(-1)!.phase).toBe('complete');
    e.dispose();
  });

  it('a card the player never touches opens on its own at the ceiling, and says so', () => {
    const e = build();
    const seen: string[] = [];
    e.subscribe((c) => seen.push(c.phase));
    const r = e.presentCard(river, input);
    const p = r.profile;
    now += p.prepareMs + p.holdMs;
    vi.advanceTimersByTime(p.prepareMs + p.holdMs);
    expect(seen).toContain('squeeze');
    expect(e.phaseAt(r.key)).toBe('squeeze');
    expect(p.prepareMs + p.holdMs).toBe(ALL_IN_SQUEEZE_CEILING_MS - 300);
    e.dispose();
  });

  it('a late release changes nothing, and a non-interactive presentation ignores it', () => {
    const e = build();
    const r = e.presentCard(river, input);
    now += r.profile.prepareMs + r.profile.holdMs + 10;
    vi.advanceTimersByTime(r.profile.prepareMs + r.profile.holdMs + 10);
    expect(e.releaseHold(r.key)).toBe(false);
    const plain = e.presentCard({ ...river, handId: 8 }, { ...base });
    expect(plain.profile.interactive).toBeFalsy();
    expect(e.releaseHold(plain.key)).toBe(false);
    expect(e.releaseHold('never')).toBe(false);
    e.dispose();
  });

  it('a released snap still runs at speed <= 1: the server is holding the stopwatch', () => {
    const e = build(1.5);
    const r = e.presentCard(river, input);
    now += 500;
    vi.advanceTimersByTime(500);
    expect(e.releaseHold(r.key)).toBe(true);
    const snap = r.profile.squeezeMs + r.profile.revealMs + r.profile.settleMs;
    now += snap;
    expect(e.phaseAt(r.key), 'the turn is over after the base snap, not 1.5x it').toBe('settle');
    e.dispose();
  });

  it('cancelling a held card clears its hold timer with everything else', () => {
    const e = build();
    const seen: string[] = [];
    e.subscribe((c) => seen.push(c.phase));
    const r = e.presentCard(river, input);
    e.cancel(r.key, 'test');
    now += ALL_IN_SQUEEZE_CEILING_MS;
    vi.advanceTimersByTime(ALL_IN_SQUEEZE_CEILING_MS);
    expect(seen.filter((p) => p === 'squeeze')).toHaveLength(0);
    expect(e.activeCount).toBe(0);
  });
});

describe('the markup carries the hold, and the pixels follow the hand', () => {
  it('only an interactive profile ever carries data-rs-hold', () => {
    expect(squeezeHostProps(P.allIn, 0, true, 'drag')['data-rs-hold']).toBe('drag');
    expect(squeezeHostProps(P.allIn, 0, true, 'released')['data-rs-hold']).toBe('released');
    expect(squeezeHostProps(P.mobile, 0, true, 'drag')['data-rs-hold']).toBeUndefined();
    expect(squeezeHostProps(P.allIn, 0, true)['data-rs-hold']).toBeUndefined();
  });
  it('drag progress is a fraction of the card width, clamped, in any direction', () => {
    expect(squeezeDragProgress(0, 0, 100)).toBe(0);
    expect(squeezeDragProgress(45, 0, 100)).toBeCloseTo(0.5, 5);
    expect(squeezeDragProgress(-45, 0, 100)).toBeCloseTo(0.5, 5);
    expect(squeezeDragProgress(0, 45, 100)).toBeCloseTo(0.5, 5);
    expect(squeezeDragProgress(500, 500, 100)).toBe(1);
    expect(SQUEEZE_RELEASE_THRESHOLD).toBeGreaterThan(0.5);
    expect(SQUEEZE_RELEASE_THRESHOLD).toBeLessThan(1);
  });
  it('the stylesheet parks the keyframes under the hand and snaps from the dragged angle', () => {
    const css = read('src/presentation/cardPresentation/cardSqueeze.css');
    const drag = css.slice(css.indexOf("[data-rs-hold='drag'] .card-squeeze {"));
    expect(drag).toMatch(
      /animation: none;\s*transform: rotateY\(calc\(var\(--rs-drag, 0\) \* 90deg\)\)/
    );
    expect(css).toContain("[data-rs-hold='released'] .card-squeeze {");
    expect(css).toContain('@keyframes ccCardSqueezeFrom');
    const from = css.slice(css.indexOf('@keyframes ccCardSqueezeFrom'));
    expect(from).toMatch(/0% \{\s*transform: rotateY\(calc\(var\(--rs-drag, 0\) \* 90deg\)\)/);
    // Still compositor-only.
    expect(from.slice(0, from.indexOf('\n}\n'))).not.toMatch(
      /\b(width|height|top|left|margin|padding|box-shadow)\s*:/
    );
    // A thumb on the card must not scroll the felt.
    expect(css).toMatch(/\[data-rs-hold\] \{\s*touch-action: none;/);
  });
  it('the board hands the engine both halves of the rule and releases through it', () => {
    const tsx = read('src/components/table/CommunityCards.tsx');
    expect(tsx).toContain('squeeze: boardMaySqueeze(squeezeEligible, runs, boardIndex)');
    expect(tsx).toContain('cardPresentationEngine.releaseHold(key)');
    expect(tsx).toContain("if (phase === 'squeeze' && key === activeSqueezeRef.current)");
    // The memo must not swallow the inputs.
    expect(tsx).toContain('if (prev.squeezeEligible !== next.squeezeEligible) return false;');
    expect(tsx).toContain('if (prev.runs !== next.runs) return false;');
  });
});

describe('the equity the squeezer sees waits for the card (Dan 2026-08-28)', () => {
  it('TablePage holds the displayed equity while the hold is on, and reads it where equity renders', () => {
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain(
      'const displayedEquities = useHeldValue(allInEquities, squeezeHolding);'
    );
    expect(page).toContain('onSqueezeHold={setSqueezeHolding}');
    // Dan 2026-09-05: "THIS ISN'T ALLOWED ON BOMB POTS". ONE board carries the
    // right (the bomb pot's boards 2 and 3 are handed nothing), and the page
    // refuses the whole hand when it is a bomb pot.
    expect(page.match(/squeezeEligible=\{heroSqueezeEligible\}/g), 'board 1 only').toHaveLength(1);
    expect(page).toContain('bombPot: bombPotActive || tableState.communityCards2.length > 0,');
    expect(page).not.toContain('onSqueezeHoldBoard');
    // AUDIT 2026-09-05: "all in" is run-out PARTICIPATION. The engine's
    // ALL_IN_RUNOUT carries getActivePlayers(), which includes the player who
    // called the shove with chips behind; status alone would have denied the
    // perk to the covering player in every heads-up all-in.
    expect(page).toMatch(
      /heroInRunout =[\s\S]*status === 'all_in' \|\|[\s\S]*allInEquities\.some\(/
    );
    expect(page).toContain('heroAllIn: heroInRunout,');
    // The two render sites of the per-seat equity read the held value...
    expect(page).toContain('displayedEquities.find((e) => e.userId === player.id)');
    expect(page).toContain("? ' seat-wrapper--equity'");
    expect(page).not.toMatch(
      /allInEquities\.find\(\(e\) => e\.userId === player\.id\) \?\?\n\s*allInEquities\.find\(\(e\) => !e\.userId && e\.seat === seatNumber\);\n\s*if \(!eq\) return null;\n\s*const isAhead/
    );
    // ...and eligibility is every clause of Dan's rule, computed locally.
    expect(page).toMatch(
      /heroSqueezeEligible = viewerMaySqueeze\(\{[\s\S]*heroAllIn:[\s\S]*isVip: viewerIsVip,[\s\S]*settingOn: v8Settings\.all_in_squeeze,[\s\S]*runItMultiple: ritRunsThisHand > 1/
    );
    // The RIT boards are told they are several.
    expect(page).toContain('runs={Math.max(2, ritBoardsView.length)}');
  });
  it('useHeldValue freezes on the same render the hold begins, and thaws to the newest value', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { result, rerender } = renderHook(
      ({ v, h }: { v: number; h: boolean }) => useHeldValue(v, h),
      { initialProps: { v: 1, h: false } }
    );
    expect(result.current).toBe(1);
    rerender({ v: 2, h: true });
    expect(result.current, 'the hold starts on this render, not one later').toBe(1);
    rerender({ v: 3, h: true });
    expect(result.current).toBe(1);
    rerender({ v: 3, h: false });
    expect(result.current).toBe(3);
  });
});

describe('the setting (R4, R5)', () => {
  it('exists, defaults ON, is VIP-gated in the meta, and is NOT a quick toggle', () => {
    expect(DEFAULT_USER_TABLE_SETTINGS.all_in_squeeze).toBe(true);
    const meta = TABLE_SETTINGS_META.find((m) => m.key === 'all_in_squeeze');
    expect(meta).toBeTruthy();
    expect(meta!.vip).toBe(true);
    expect(meta!.quick, 'the hub quick list has no VIP gate in front of it').toBeFalsy();
    expect(TABLE_SETTINGS_META.filter((m) => m.vip).map((m) => m.key)).toEqual(['all_in_squeeze']);
  });
  it('crosses devices: it is on the relay allowlist', () => {
    const sync = read('src/services/PostgresSyncHooks.ts');
    expect(sync).toContain("'all_in_squeeze'");
  });
  it('is loaded from the row with the default as fallback', () => {
    expect(read('src/hooks/useUserTableSettings.ts')).toContain(
      'all_in_squeeze: data.all_in_squeeze ?? DEFAULT_USER_TABLE_SETTINGS.all_in_squeeze'
    );
  });
  it('the migration adds the column NOT NULL DEFAULT true in one transaction, and is declared', () => {
    const sql = read(
      'supabase/migrations/20260905195426_user_table_settings_gain_the_all_in_squeeze_toggle.sql'
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS all_in_squeeze boolean NOT NULL DEFAULT true/);
    expect(sql.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;/gm)).toHaveLength(1);
    const manifest = JSON.parse(read('scripts/ci/schema-manifest.d/vip-all-in-squeeze.json'));
    expect(manifest.columns.user_table_settings).toContain('all_in_squeeze');
  });
  it('a non-VIP sees the switch OFF whatever is stored, a VIP sees what is stored', () => {
    expect(effectiveSettingValue(true, true, false, false)).toBe(false);
    expect(effectiveSettingValue(true, true, true, false)).toBe(true);
    expect(effectiveSettingValue(false, true, true, false)).toBe(false);
    // While the VIP check is in flight the stored value shows (no flash).
    expect(effectiveSettingValue(true, true, false, true)).toBe(true);
    // An ungated setting is untouched by any of it.
    expect(effectiveSettingValue(true, undefined, false, false)).toBe(true);
    expect(effectiveSettingValue(false, false, true, false)).toBe(false);
  });
  it('the panel answers a non-VIP tap with the upsell and NO write', () => {
    const panel = read('src/components/table/TableSettingsPanel.tsx');
    expect(panel).toMatch(/if \(!isVIP\) \{\s*announceVipRequired\(\);\s*return;\s*\}/);
    expect(panel).toContain("masterBus.emit('SHOW_TOAST'");
    expect(panel).toContain('onClick={onClick}');
  });
  it('the upsell is Title Case Every Word, names the VIP card, and has no em dash', () => {
    const msg = ALL_IN_SQUEEZE_VIP_REQUIRED_MESSAGE;
    expect(msg).toMatch(/VIP Card/);
    expect(msg).not.toContain('—');
    expect(formatPopupText(msg)).toBe(msg);
  });
});

describe('Animation Law 10.6 is intact', () => {
  it('with the perk off the card still animates a full reveal with sound - a different profile, never none', () => {
    const off = resolveCardAnimationProfile({ ...base, allIn: true, squeeze: false });
    expect(off.intensity).not.toBe('off');
    expect(off.durationMs).toBeGreaterThan(0);
    expect(off.audioEnabled).toBe(true);
  });
  it('the resolver still reads no user "off" preference', () => {
    const src = read('src/presentation/cardPresentation/resolveProfile.ts');
    expect(src).not.toMatch(/skip_animations|animationsOff/);
  });
});
