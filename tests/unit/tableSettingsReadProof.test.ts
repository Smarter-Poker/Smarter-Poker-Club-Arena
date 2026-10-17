import type { Response } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import {
  isCompleteSettingsRead,
  requireOwnSettingsRow,
} from '../e2e/support/tableSettingsReadProof';

function reply({
  method = 'GET',
  select = '*',
  owner = 'owner',
  status = 200,
  body = [{ user_id: 'owner', auto_time_bank: true }] as unknown,
} = {}) {
  return {
    url: () =>
      `https://example.test/rest/v1/user_table_settings?select=${encodeURIComponent(select)}&user_id=eq.${owner}`,
    request: () => ({ method: () => method }),
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
  } as unknown as Response;
}

describe('complete authenticated table settings readiness', () => {
  it('accepts the full own-row read, never a shell projection, write or other account', () => {
    expect(isCompleteSettingsRead(reply(), 'owner')).toBe(true);
    expect(isCompleteSettingsRead(reply({ select: 'show_avatars' }), 'owner')).toBe(false);
    expect(isCompleteSettingsRead(reply({ method: 'POST' }), 'owner')).toBe(false);
    expect(isCompleteSettingsRead(reply({ owner: 'other' }), 'owner')).toBe(false);
    expect(isCompleteSettingsRead(reply({ owner: '' }))).toBe(false);
  });
  it('rejects duplicate owner filters', () => {
    const response = reply();
    response.url = () =>
      'https://example.test/rest/v1/user_table_settings?select=*&user_id=eq.owner&user_id=eq.other';
    expect(isCompleteSettingsRead(response, 'owner')).toBe(false);
  });
  it('keeps HTTP refusal visible instead of using defaults', async () => {
    await expect(requireOwnSettingsRow(reply({ status: 403 }), 'owner')).rejects.toThrow(
      'HTTP 403'
    );
  });
  it('refuses a response or payload owned by somebody else', async () => {
    await expect(requireOwnSettingsRow(reply({ owner: 'other' }), 'owner')).rejects.toThrow(
      'signed-in account'
    );
    await expect(
      requireOwnSettingsRow(reply({ body: { user_id: 'other' } }), 'owner')
    ).rejects.toThrow('another account');
  });
  it('preserves false, and recognizes a positively read absent row', async () => {
    expect(
      await requireOwnSettingsRow(
        reply({ body: [{ user_id: 'owner', auto_time_bank: false }] }),
        'owner'
      )
    ).toEqual({ user_id: 'owner', auto_time_bank: false });
    expect(await requireOwnSettingsRow(reply({ body: [] }), 'owner')).toBeNull();
  });
  it.each([42, [{ user_id: 'owner' }, { user_id: 'owner' }], [[]]])(
    'rejects an invalid own-row shape',
    async (body) => {
      await expect(requireOwnSettingsRow(reply({ body }), 'owner')).rejects.toThrow();
    }
  );
  it('waits for a six-second native read before declaring the row ready', async () => {
    vi.useFakeTimers();
    try {
      const response = reply();
      response.json = () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ user_id: 'owner', auto_time_bank: true }), 6000)
        );
      let settled = false;
      const ready = requireOwnSettingsRow(response, 'owner').then((row) => {
        settled = true;
        return row;
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await ready).toEqual({ user_id: 'owner', auto_time_bank: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
