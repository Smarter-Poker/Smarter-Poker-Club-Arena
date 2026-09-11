import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { staticPublicationJournal } from '../../scripts/ci/static-publication-journal.mjs';

for (const minutes of [360, 55, 10])
  test(`existing static run keeps one claim through controlled qualification wait and ${minutes}m original expiry`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'static-wait-'));
    const operation = '11111111-1111-4111-8111-111111111111';
    const start = 1000000000000;
    let now = start,
      claims = [];
    const request = {
      static_version: 1,
      phase: 'BUILD',
      target: 'club-arena-web',
      repository: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      repository_id: '123',
      control_sha: 'a'.repeat(40),
      source_sha: 'a'.repeat(40),
      workflow_id: 400,
      manifest_digest: 'b'.repeat(64),
      not_after_epoch: Math.floor(start / 1000) + minutes * 60,
      static_authority: {
        url: 'https://fixture.example.invalid/static-publication',
        installation_receipt: operation,
        audience: 'club-arena-static-publication',
      },
    };
    const environment = {
      RELEASE_STATIC_REQUEST: JSON.stringify(request),
      RELEASE_STATIC_BUILD_OPERATION: operation,
      GITHUB_EVENT_NAME: 'repository_dispatch',
      GITHUB_REPOSITORY: request.repository,
      GITHUB_REPOSITORY_ID: '123',
      GITHUB_SHA: request.control_sha,
      GITHUB_RUN_ATTEMPT: '1',
      RELEASE_STATIC_AUTHORITY_URL: request.static_authority.url,
      RELEASE_STATIC_INGRESS_RECEIPT: operation,
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://fixture.actions.githubusercontent.com/oidc',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-only',
    };
    try {
      await assert.rejects(
        staticPublicationJournal({
          phase: 'wait',
          environment,
          directory,
          github: async () => {
            throw Error('no dispatch allowed');
          },
          now: () => now,
          wait: async (ms) => {
            now += ms;
          },
          fetchImpl: async (url, options) => {
            if (String(url).includes('/oidc'))
              return Response.json({ value: 'fixture-signed-identity' });
            claims.push(JSON.parse(options.body));
            return Response.json({ ready: false });
          },
        }),
        /RELEASE_STATIC_AUTHORIZATION_DEADLINE/
      );
      const expected = Math.max(0, Math.min(120, minutes - 20));
      assert.equal(now - start, expected * 60000);
      assert.equal(claims.length, expected * 6);
      const saved = JSON.parse(await readFile(path.join(directory, 'claim-key.json'), 'utf8'));
      assert.ok(
        claims.every(
          (claim) => claim.claim_key === saved.claim_key && claim.build_operation_id === operation
        )
      );
      assert.equal(
        await readFile(path.join(directory, 'publication.json'), 'utf8').catch(() => null),
        null
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
