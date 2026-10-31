import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261016024912_cashier_sends_use_the_selected_source_and_destination_wallet.sql',
  'utf8'
);
const contract = readFileSync('scripts/verification-harness/cashier-release-contract.sql', 'utf8');

it.each([
  [
    'fn_cashier_batch_transfer',
    '4951dcaf2013c43faa90a7a707807ad3',
    '859bb844228d65085bf134c4dbd8b32b',
  ],
  [
    'fn_cashier_operation_intent_guard',
    '4441e55c7f8b750b93b513c6e18f3f24',
    '60350724279387da3b548bd370d082db',
  ],
  [
    'fn_promo_wallet_send_core_20261004',
    'b6b0c7686b67d33e2b01c132f8775cbc',
    '9902bccc4d422766b3611e050eeec770',
  ],
  [
    'fn_club_promo_send_core_20261004',
    '5990c675526e842d0671f47890c1ff27',
    '5d037d10de17314377a263d96a18556f',
  ],
])(
  'certifies installed %s from the qualified selected-wallet source',
  (name, bodyHash, definitionHash) => {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const definition = migration.slice(start);
    const match = definition.match(/\bAS (\$[A-Za-z0-9_]*\$)/i)!;
    expect(match).toBeTruthy();
    const bodyStart = match.index! + match[0].length;
    const bodyEnd = definition.indexOf(match[1], bodyStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    expect(createHash('md5').update(definition.slice(bodyStart, bodyEnd)).digest('hex')).toBe(
      bodyHash
    );
    const proof = migration
      .split('\n')
      .find((line) => line.startsWith('-- @live-proof:') && line.includes(`public.${name}(`));
    expect(proof).toContain(`= '${definitionHash}'`);
    if (name === 'fn_club_promo_send_core_20261004') {
      // Follow both installed successors: restricted agent banks, then the
      // journal-source label. Never certify a retired or observed-only body.
      const successor = readFileSync(
        'supabase/migrations/20261020210238_restrict_agent_banks_and_authorize_downline_reassignment.sql',
        'utf8'
      );
      const at = successor.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      expect(at).toBeGreaterThanOrEqual(0);
      const next = successor.slice(at);
      const tag = next.match(/\bAS (\$[A-Za-z0-9_]*\$)/i)!;
      const from = tag.index! + tag[0].length;
      const successorBody = next.slice(from, next.indexOf(tag[1], from));
      const successorHash = createHash('md5').update(successorBody).digest('hex');
      expect(successorHash).not.toBe(bodyHash);
      const captured = JSON.parse(
        readFileSync('scripts/ci/fixtures/club-promo-journal-source.json', 'utf8')
      ).find((item: { signature: string }) => item.signature.startsWith(`${name}(`));
      expect(captured).toBeTruthy();
      const capturedTag = captured.definition.match(/\bAS (\$[A-Za-z0-9_]*\$)/i)!;
      const capturedFrom = capturedTag.index! + capturedTag[0].length;
      expect(
        captured.definition.slice(
          capturedFrom,
          captured.definition.indexOf(capturedTag[1], capturedFrom)
        )
      ).toBe(successorBody);
      const journalMigration = readFileSync(
        'supabase/migrations/20261029065153_club_promo_send_names_its_journal_source_column.sql',
        'utf8'
      );
      const coreStart = journalMigration.indexOf(`d := pg_get_functiondef('public.${name}(`);
      expect(coreStart).toBeGreaterThanOrEqual(0);
      const corePatch = journalMigration.slice(
        coreStart,
        journalMigration.indexOf('  EXECUTE d;', coreStart)
      );
      const preimageHash = createHash('md5').update(captured.definition).digest('hex');
      expect(corePatch).toContain(`IF md5(d) <> '${preimageHash}'`);
      const replacement = corePatch.match(
        /d := replace\(d, '((?:''|[^'])*)', '((?:''|[^'])*)'\);/
      )!;
      expect(replacement).toBeTruthy();
      const needle = replacement[1].replaceAll("''", "'");
      const inserted = replacement[2].replaceAll("''", "'");
      expect(successorBody.split(needle)).toHaveLength(2);
      const installedHash = createHash('md5')
        .update(successorBody.replace(needle, inserted))
        .digest('hex');
      expect(installedHash).toBe('aa695a9cec9ffb9516cf329fcd04fcf9');
      expect(contract).toContain(`'hash', '${installedHash}'`);
      expect(contract).not.toContain(`'hash', '${successorHash}'`);
      expect(contract).not.toContain(`'hash', '${bodyHash}'`);
      expect(contract).toContain("version = '20261029065153'");
      expect(contract).toContain("name = 'club_promo_send_names_its_journal_source_column'");
      return;
    }
    const expected = name === 'fn_cashier_batch_transfer' ? definitionHash : bodyHash;
    expect(contract).toContain(`'hash', '${expected}'`);
  }
);

it.each([
  [
    'fn_club_wallet_claim_back',
    '20261027164937_agents_reclaim_from_their_own_wallets_at_any_time.sql',
    '54450c4c6f5e6ca4d3b7804a669bf0cc',
  ],
  [
    'fn_cashier_history_feed',
    '20261027160320_cashier_claim_destination_and_movement_history.sql',
    'dad4d92ef739f520d0c512c9950d5c62',
  ],
  [
    'fn_cashier_history_summary',
    '20261027160320_cashier_claim_destination_and_movement_history.sql',
    'cf02a67ac0d71d5e0db7c84a5b224f23',
  ],
])('certifies only the qualified installed reclaim/history successor %s', (name, file, hash) => {
  const installed = readFileSync(`supabase/migrations/${file}`, 'utf8');
  const proof = installed
    .split('\n')
    .find((line) => line.startsWith('-- @live-proof:') && line.includes(`public.${name}(`));
  expect(proof).toContain(`= '${hash}'`);
  const start = contract.indexOf(`'signature', 'public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const entry = contract.slice(start, contract.indexOf('\n    )', start));
  expect(
    [...entry.matchAll(/'(?:replacement_)?hash', '([a-f0-9]{32})'/g)].map((match) => match[1])
  ).toEqual([hash]);
  expect(entry).toContain("'owner', 'postgres'");
  expect(contract).toContain("version = '20261027160320'");
  expect(contract).toContain("version = '20261027164937'");
  expect(contract).toContain("RAISE EXCEPTION 'cashier function owner drift: %'");
  expect(contract).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
  expect(contract).toContain("NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')");
  expect(contract).toContain("NOT has_function_privilege('service_role', v_oid, 'EXECUTE')");
});
