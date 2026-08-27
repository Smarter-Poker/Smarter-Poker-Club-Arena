/**
 * HOUSE ADS — the rules that must not drift back.
 *
 * Source-pinned rather than behaviour-mocked, the way this repo pins its
 * engine/client contracts (see winningCardHighlight.test.ts): the things worth
 * guarding here are decisions Dan made out loud, and the failure mode is
 * somebody quietly re-adding one of them months from now.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

const SERVICE = read('src/services/AdService.ts');
const STRIP = read('src/components/lobby/LobbyAdStrip.tsx');
const ADMIN = read('src/pages/admin/HouseAdsPage.tsx');

describe('VIP members see house ads (Dan 2026-08-27)', () => {
  /* "even vips will see ads remove that for now." The ad-free promise had been
     SOLD in the present tense on the Diamond Store and repeated by Geeves, so
     the risk runs both ways: someone re-adding suppression here, or someone
     re-advertising ad-free over there. */
  it('the ad service contains no VIP suppression', () => {
    // A comment may mention VIP; a code path must not gate on it.
    const code = SERVICE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/is_?[Vv]ip/);
    expect(code).not.toMatch(/isVIP/);
  });

  it('records the ruling so the next reader does not "fix" it back', () => {
    expect(SERVICE).toMatch(/even vips will see ads/i);
  });
});

describe('house ads never outrank a club speaking to its own players', () => {
  it('sorts HOUSE last in the merged strip', () => {
    const merged = STRIP.slice(
      STRIP.indexOf('const merged = ['),
      STRIP.indexOf('.slice(0, MAX_ADS)')
    );
    const club = merged.indexOf('clubAds.filter((a) => a.pinned)');
    const union = merged.indexOf('...unionAds');
    const house = merged.indexOf('...houseLobbyAds');
    expect(club).toBeGreaterThan(-1);
    expect(house).toBeGreaterThan(union);
    expect(union).toBeGreaterThan(club);
  });

  it('keeps the three sources labelled rather than merged anonymously', () => {
    expect(STRIP).toMatch(/'CLUB' \| 'UNION' \| 'HOUSE'/);
    expect(STRIP).toMatch(/lobby-ads__tag/);
  });
});

describe('impressions are counted honestly', () => {
  it('de-duplicates per page load rather than per render', () => {
    /* The strip rotates every 7s and re-renders constantly. Counting renders
       would divide every campaign's click-through rate by a meaningless
       number. */
    expect(SERVICE).toMatch(/seenThisLoad/);
    expect(SERVICE).toMatch(/logImpression/);
  });

  it('only tracks HOUSE ads, not a club or union announcement', () => {
    expect(STRIP).toMatch(/visibleAd\?\.source === 'HOUSE'/);
  });

  it('logs the click BEFORE navigating away', () => {
    const activate = STRIP.slice(
      STRIP.indexOf('const handleActivate'),
      STRIP.indexOf('const stripClass')
    );
    expect(activate.indexOf('logClick')).toBeGreaterThan(-1);
    expect(activate.indexOf('logClick')).toBeLessThan(activate.indexOf('onNavigate'));
  });
});

describe('a write that changed nothing never reports success', () => {
  /* Caught by the World Hub Silent Write Guard on the first push of this
     feature, naming both lines. PostgREST answers a zero-row match with
     { error: null }, so a PATCH against an ad deleted in another tab would
     have reported "Saved" and changed nothing. */
  it('the panel does not claim an ad is live when placement failed', () => {
    const save = ADMIN.slice(ADMIN.indexOf('const handleSave'), ADMIN.indexOf('// ── Delete'));
    expect(save).toMatch(/created\.placed === false/);
    // The warning must reach the eye, not the cheerful banner.
    const warnBranch = save.slice(save.indexOf('created.placed === false'));
    expect(warnBranch.indexOf('setActionError')).toBeLessThan(
      warnBranch.indexOf('setNotice(editingId')
    );
  });
});

describe('the admin panel is platform staff only, and fails closed', () => {
  it('gates on the platform role, not club membership', () => {
    expect(ADMIN).toMatch(/\['admin', 'super_admin'\]/);
  });

  it('treats an unreadable role as NOT allowed', () => {
    const check = ADMIN.slice(ADMIN.indexOf('HouseAdsPage.checkRole'), ADMIN.indexOf('// ── Load'));
    expect(check).toMatch(/setAllowed\(false\)/);
  });

  it('renders a dash, never a zero, when performance could not be read', () => {
    /* A confident zero reads as "this campaign got no clicks" when the truth
       is "we could not count" — the exact class of lie the cashier and lobby
       audits kept finding. */
    expect(ADMIN).toMatch(/stats === null \? '-'/);
    expect(ADMIN).toMatch(/Could Not Be Read/i);
  });
});
