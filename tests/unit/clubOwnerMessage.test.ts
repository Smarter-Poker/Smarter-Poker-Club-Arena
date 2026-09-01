/**
 * THE CLUB MESSAGE LEADS THE LOBBY RAIL, AND SOMEBODY CAN WRITE IT
 * (Dan 2026-09-01)
 *
 * "on desktop in the club arena, the 'welcome to club jaqk' thats on the bottom
 * of the wallets should be at the top above the club card, and that should be
 * the 'custom clickable message' for the club owners to put the days message,
 * or something custom"
 *
 * Three claims, three pins: it is above the club card, it is clickable, and the
 * edit path actually reaches the database rather than being a control that
 * looks writable and is not.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clubOwnerMessageLine } from '../../src/components/club/ClubOwnerMessage';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const PAGE = read('src/pages/ClubHomePage.tsx');
const COMPONENT = read('src/components/club/ClubOwnerMessage.tsx');
const SETTINGS = read('src/pages/ClubSettingsPage.tsx');
const MIGRATION = read('supabase/migrations/20260901120000_club_lobby_owner_message.sql');

describe('where it sits', () => {
  it('leads the rail: above the club card and above the wallets', () => {
    expect(PAGE).toContain('<ClubOwnerMessage');
    expect(PAGE.indexOf('<ClubOwnerMessage')).toBeLessThan(PAGE.indexOf('<ClubIdentityCard'));
    expect(PAGE.indexOf('<ClubOwnerMessage')).toBeLessThan(PAGE.indexOf('<DynamicWallet'));
  });

  it('no longer renders the old paragraph at the bottom of the wallet stack', () => {
    expect(PAGE).not.toContain('<p className="lobby-top__house-welcome">');
  });
});

describe('what it says', () => {
  it('prints the owner message when there is one', () => {
    expect(clubOwnerMessageLine('Freeroll At Nine', 'All Welcome', 'Club Jaqk')).toBe(
      'Freeroll At Nine'
    );
  });

  it('falls back to the tag line, so nothing a club already wrote disappears', () => {
    expect(clubOwnerMessageLine(null, 'All Welcome', 'Club Jaqk')).toBe('All Welcome');
    expect(clubOwnerMessageLine('   ', 'All Welcome', 'Club Jaqk')).toBe('All Welcome');
  });

  it('is never blank: a rail with an empty first row reads as a broken page', () => {
    expect(clubOwnerMessageLine(null, null, 'Club Jaqk')).toBe('Welcome To Club Jaqk');
    expect(clubOwnerMessageLine(undefined, '  ', 'Club Jaqk')).toBe('Welcome To Club Jaqk');
  });

  it('keeps player copy free of em dashes (CLAUDE.md 10.7)', () => {
    /* The rule is about the characters inside text a PLAYER reads, so the
       check is scoped to the strings this component renders rather than to the
       whole file - a banner comment is not copy. */
    const strings = COMPONENT.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || [];
    expect(strings.length).toBeGreaterThan(0);
    for (const literal of strings) expect(literal).not.toContain('\u2014');
  });
});

describe('clickable, and the click does something', () => {
  it('is a button, not a paragraph', () => {
    expect(COMPONENT).toMatch(/<button[\s\S]*?className="lobby-top__house-welcome"/);
  });

  it('opens the message in full and offers the announcements page', () => {
    expect(COMPONENT).toContain('club-owner-message__full');
    expect(COMPONENT).toContain('View Club Announcements');
    expect(COMPONENT).toContain('onOpenAnnouncements');
    expect(PAGE).toContain(
      'onOpenAnnouncements={() => navigate(`/clubs/${clubId}/announcements`)}'
    );
  });
});

describe('the edit path is real, not a stub', () => {
  it('writes through the RPC rather than an open UPDATE on clubs', () => {
    expect(COMPONENT).toContain("supabase.rpc('fn_set_club_lobby_message'");
    // `clubs` also carries treasury, rake and level columns. The client never
    // gets a hammer that wide for one text field.
    expect(COMPONENT).not.toMatch(/from\('clubs'\)[\s\S]{0,80}\.update/);
  });

  it('ships the migration that gives the database the column and the function', () => {
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS lobby_message');
    expect(MIGRATION).toContain('CREATE OR REPLACE FUNCTION public.fn_set_club_lobby_message');
    expect(MIGRATION).toContain('fn_is_club_admin_uid');
    // One migration, one transaction, one PostgREST schema reload.
    expect(MIGRATION).toContain('BEGIN;');
    expect(MIGRATION).toContain('COMMIT;');
  });

  it('is also editable where an owner already manages the club', () => {
    expect(SETTINGS).toContain('htmlFor="club-lobby-message"');
    expect(SETTINGS).toContain('lobby_message: toSave.lobby_message || null');
  });
});
