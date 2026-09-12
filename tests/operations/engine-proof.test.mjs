import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCluster } from './postgres-fixture.mjs';
import { connect } from '../../operations/release/journal.mjs';
import { EngineReadiness, readDoorCatalogue, catalogueDigest } from '../../operations/release/engine-readiness.mjs';
import { EngineStageAdapter, artifactDownload } from '../../operations/release/adapters/engine-stage.mjs';
import { GitHubCertificationAdapter } from '../../operations/release/adapters/github-certification.mjs';
import { certificateProof } from '../../operations/release/certificate-proof.mjs';
import { operationPolicyDigest } from '../../operations/release/operation-policy.mjs';

const sha = (x) => x.repeat(40), image = `sha256:${'e'.repeat(64)}`;
const repo = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const health = (source = sha('a')) => ({ running: true, liveness: 'ok', releaseSha: source,
  instanceId: '12345-abcd1234', maintenance: { policyVersion: 2, policyDigest: operationPolicyDigest,
    activationReceipt: 'installed-fixture', operation: { operationId: 'operation-fixture', phase: 'resumed' } } });
const publicRead = (getHealth) => async (url) => url.includes('/health') ? getHealth() : { ca_sha: sha('f') };

test('native PostgreSQL door proof detects changed and missing runtime functions without writes', async () => {
  const cluster = await createCluster(); let client;
  try {
    client = await connect(await cluster.database());
    await client.query('CREATE FUNCTION public.release_test_door() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
    const names = ['release_test_door'];
    const rows = await readDoorCatalogue(client, names);
    const compatibility = { mode: 'backward-compatible-engine', unchanged_frontend_sha: sha('f'),
      database_contract_digest: catalogueDigest(rows), operation_policy_digest: operationPolicyDigest, receipt_refs: ['fixture'] };
    const snapshot = { queue: { resolution_manifest: { components: [{ target: 'club-arena-engine', compatibility }] } },
      receipts: { BUILD: { data: { database_doors: { names, exceptions: {}, digest: catalogueDigest({ names, exceptions: {} }) } } } } };
    let observed = health(sha('9')), calls = 0;
    const readiness = new EngineReadiness({ catalogue: (n) => readDoorCatalogue(client, n),
      intake: { preflight: async () => { calls++; return { ready: true }; } }, publicJSON: publicRead(() => observed) });
    const request = { expected_current: { source_sha: sha('9'), image_id: image } };
    assert.equal((await readiness.verify(snapshot, request, {})).technical_gates_passed, true);
    observed = { ...observed, maintenance: { ...observed.maintenance, policyDigest: '0'.repeat(64) } };
    await assert.rejects(readiness.verify(snapshot, request, {}), /READINESS_UNPROVEN/);
    observed = health(sha('9'));
    await client.query('CREATE OR REPLACE FUNCTION public.release_test_door() RETURNS integer LANGUAGE sql AS $$ SELECT 2 $$');
    await assert.rejects(readiness.verify(snapshot, request, {}), /READINESS_UNPROVEN/);
    await client.query('DROP FUNCTION public.release_test_door()');
    await assert.rejects(readiness.verify(snapshot, request, {}), /READINESS_UNPROVEN/);
    assert.equal(calls, 2); // Changed schema fails before any native preflight.
    assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'off');
  } finally { await client?.end(); await cluster.close(); }
});

test('stage adapter binds artifact bytes and native terminal proof to this operation only', async () => {
  const r = { target: 'club-arena-engine', control_sha: sha('c'), source_sha: sha('a'), server_tree_sha: sha('b'),
    manifest_digest: 'd'.repeat(64), run_key: '123-1', build_run_id: '123', build_operation_id: randomUUID(),
    github_artifact_id: '45', archive_digest: image, github_archive_digest: image, artifact_image_id: image,
    archive_bytes: 100, github_archive_bytes: 110, expected_current: { source_sha: sha('9'), image_id: image } };
  const op = { id: randomUUID(), epoch: randomUUID() }; let sends = 0, wrong = false;
  const adapter = new EngineStageAdapter({ controlSha: sha('c'), repo,
    github: async () => ({ id: 45, digest: image, size_in_bytes: 110, expired: false, workflow_run: { id: 123 } }),
    request: async (action) => {
      if (action === 'preflight') return { ready: true, ...r.expected_current };
      if (action === 'receive') { sends++; throw new Error('fixture lost acceptance'); }
      return { terminal: true, outcome: 'SUCCEEDED', operation_id: wrong ? randomUUID() : op.id,
        source_sha: r.source_sha, control_sha: r.control_sha, run_key: r.run_key, image_id: image, archive_digest: image };
    } });
  await adapter.preflight(r, op);
  await assert.rejects(adapter.submit(r, op));
  assert.equal((await adapter.reconcile(r, op)).outcome, 'SUCCEEDED');
  wrong = true; await assert.rejects(adapter.reconcile(r, op)); assert.equal(sends, 1);
});

test('streaming download never forwards GitHub credential to signed storage and refuses truncated or changed bytes', async () => {
  const bytes = Buffer.from('native-fixture-bytes'), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  let changed = false, reads = 0;
  const download = artifactDownload('fixture-only-token', repo, async (url, options) => {
    reads++;
    if (String(url).startsWith('https://api.github.com/')) {
      assert.equal(options.redirect, 'manual'); assert.ok(options.headers.Authorization);
      return new Response(null, { status: 302, headers: { location: 'https://fixture.blob.core.windows.net/object' } });
    }
    assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error');
    return new Response(changed ? bytes.subarray(1) : bytes);
  });
  const r = { github_artifact_id: '45', github_archive_bytes: bytes.length, github_archive_digest: digest };
  const collect = async () => { const chunks=[]; for await (const chunk of download(r)) chunks.push(chunk); return Buffer.concat(chunks); };
  assert.deepEqual(await collect(), bytes); changed=true; await assert.rejects(collect()); assert.equal(reads,4);
});

function zip(proof) {
  const name=Buffer.from('receipt.json'), body=Buffer.from(JSON.stringify(proof)), local=Buffer.alloc(30), central=Buffer.alloc(46), end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(body.length,18); local.writeUInt32LE(body.length,22); local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(body.length,20); central.writeUInt32LE(body.length,24); central.writeUInt16LE(name.length,28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1,8); end.writeUInt16LE(1,10); end.writeUInt32LE(central.length+name.length,12); end.writeUInt32LE(local.length+name.length+body.length,16);
  return Buffer.concat([local,name,body,central,name,end]);
}

test('real certification adapter resumes persisted observation and resets after a gap or engine replacement', async () => {
  let now = 1000000, served = health(), publication = true;
  const op = { id: randomUUID(), created_at: new Date().toISOString() };
  const r = { repository: repo, phase: 'CERTIFY', target: 'club-arena-engine', control_sha: sha('c'), workflow_id: 456,
    source_sha: sha('a'), frontend_source_sha: sha('f'), manifest_digest: 'd'.repeat(64), artifact_image_id: image,
    publication_operation_id: randomUUID(), operation_policy_digest: operationPolicyDigest, maintenance_operation_id: 'operation-fixture' };
  const proof = () => ({ operation_id: op.id, request: r, control_sha: sha('c'), run_id: '567', success: true,
    cleanup_complete: true, unchanged_release: true, served_components: { 'club-arena-engine': { identity: image } },
    engine_instance: served.instanceId, frontend_source_sha: sha('f') });
  const adapter = new GitHubCertificationAdapter({ repo, controlRef: 'heads/release-control', controlSha: sha('c'), workflowId: 456,
    runtimeImage: `node:22-slim@sha256:${'e'.repeat(64)}`, now: () => now, publicJSON: publicRead(() => served),
    publicationReadback: async () => ({ terminal: publication, outcome: 'SUCCEEDED', image_id: image }),
    request: async (url) => {
      if (url.includes('/git/ref/')) return { object: { sha: sha('c') } };
      if (url.endsWith('/workflows/456')) return { id:456, state:'active', path:'.github/workflows/post-deploy-e2e.yml' };
      if (url.includes('/workflows/456/runs?')) return { total_count:1, workflow_runs:[{ id:567,workflow_id:456,head_sha:sha('c'),
        display_title:`release:${op.id}:CERTIFY`,event:'workflow_dispatch',path:'.github/workflows/post-deploy-e2e.yml',run_attempt:1,status:'completed',conclusion:'success' }] };
      const bytes=zip(proof());
      if (url.includes('/runs/567/artifacts')) return { total_count:1,artifacts:[{ id:999,name:`release-receipt-${op.id}`,expired:false,
        digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}` }] };
      if (url.endsWith('/999/zip')) return bytes;
      throw new Error('unexpected fixture endpoint');
    } });
  await adapter.preflight(r,op);
  let previous=await adapter.reconcile(r,op); assert.equal(previous.terminal,false);
  for(let i=0;i<9;i++) { now+=60000; previous=await adapter.reconcile(r,{...op,previous_observation:previous}); assert.equal(previous.terminal,false); }
  now+=60000; previous=await adapter.reconcile(r,{...op,previous_observation:previous}); assert.equal(previous.terminal,true);
  now+=120001; previous=await adapter.reconcile(r,{...op,previous_observation:previous}); assert.equal(previous.terminal,false); assert.equal(previous.stable_since_ms,now);
  now+=60000; served={...served,instanceId:'12346-abcd1234'};
  previous=await adapter.reconcile(r,{...op,previous_observation:previous}); assert.equal(previous.stable_since_ms,now);
  publication=false; await assert.rejects(adapter.preflight(r,op));
  served.maintenance.operation.phase='releasing'; await assert.rejects(adapter.reconcile(r,op));
});

test('certificate workflow cannot attest failed cleanup or an engine instance changed during E2E', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'ca-certificate-')); let served=health();
  const request={repository:repo,control_sha:sha('c'),phase:'CERTIFY',target:'club-arena-engine',source_sha:sha('a'),frontend_source_sha:sha('f'),
    manifest_digest:'d'.repeat(64),artifact_image_id:image,operation_policy_digest:operationPolicyDigest};
  const args={request,operation:randomUUID(),directory,publicJSON:publicRead(()=>served),env:{GITHUB_REPOSITORY:repo,GITHUB_SHA:sha('c'),GITHUB_RUN_ID:'567',
    CERTIFICATE_JOB_STATUS:'success',CERTIFICATE_CLEANUP:'success',CERTIFICATE_HONESTY:'success',CERTIFICATE_UNCHANGED:'success'}};
  try {
    await certificateProof({...args,phase:'start'});
    await assert.rejects(certificateProof({...args,phase:'finish',env:{...args.env,CERTIFICATE_CLEANUP:'failure'}}));
    served={...served,instanceId:'12346-abcd1234'}; await assert.rejects(certificateProof({...args,phase:'finish'}));
    served=health(); await certificateProof({...args,phase:'finish'});
    assert.equal(JSON.parse(await readFile(path.join(directory,'receipt.json'),'utf8')).cleanup_complete,true);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
