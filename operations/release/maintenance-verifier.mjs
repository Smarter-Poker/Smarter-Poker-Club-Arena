#!/usr/bin/env node
import { connect as socketConnect } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './journal.mjs';
import { maintenanceCall } from './maintenance-journal.mjs';
import { installedConfiguration, rootOwnedFile } from './installed-bundle.mjs';
import { EngineReadiness, readDoorCatalogue, catalogueDigest, publicReleaseJSON } from './engine-readiness.mjs';
import { engineTransport, HetznerIntakeAdapter } from './adapters/hetzner.mjs';
import { operationPolicyDigest } from './operation-policy.mjs';

const need = (v) => { if (!v) throw new Error('RELEASE_MAINTENANCE_VERIFICATION_REFUSED'); };
const uuid = /^[0-9a-f-]{36}$/;
export class MaintenanceVerifier {
  constructor({ client, readiness, nativeProof, publicJSON = publicReleaseJSON, catalogue, actor = 'installed-maintenance-verifier' }) {
    Object.assign(this, { client, readiness, nativeProof, publicJSON, catalogue, actor });
  }
  async verify(input) {
    need(input && Object.keys(input).every(k=>['action','release_id','operation_id'].includes(k)) &&
      ['need','safe_resume'].includes(input.action) && uuid.test(input.release_id) &&
      (input.operation_id === undefined || uuid.test(input.operation_id)));
    const context = await maintenanceCall(this.client,'engine_maintenance_verification_context',[input.release_id,input.operation_id ?? null]);
    const { queue, receipts, provider_plan: plan, provider_operation: publication } = context;
    need(queue.release_id === input.release_id && plan.request.target === 'club-arena-engine' &&
      plan.readiness_event === receipts.READINESS.event_id && plan.request.manifest_digest === queue.resolution_manifest_digest);
    if (input.action === 'need') {
      if (context.need_receipt) return { receipt_id: context.need_receipt };
      await this.readiness.verify(context,plan.request,{id:plan.id,epoch:queue.epoch});
      const native = await this.nativeProof('maintenance-need', {request:plan.request,operation_id:plan.id,epoch:queue.epoch});
      need(native.observation?.ready === true && /^[0-9a-f]{64}$/.test(native.digest));
      const receipt = await maintenanceCall(this.client,'register_engine_maintenance_need',[input.release_id,receipts.READINESS.event_id,plan.id,{
        purpose:'engine_replacement',policy_digest:operationPolicyDigest,scope:{type:'platform'},
        receipt_refs:[`native-proof-sha256:${native.digest}`, ...native.recovery.receipt_refs],
        actual_recovery_ms:native.recovery.actual_recovery_ms,recovery_margin_ms:native.recovery.recovery_margin_ms
      },this.actor]);
      return {receipt_id:receipt};
    }
    need(context.operation?.operation_id === input.operation_id && publication?.kind === 'PUBLISH' && publication.status === 'SUCCEEDED' &&
      publication.intent.plan_id === plan.id);
    if (context.safe_resume_receipt) return {receipt_id:context.safe_resume_receipt};
    const native = await this.nativeProof('maintenance-safe-resume', {request:plan.request,operation_id:publication.id,epoch:publication.epoch});
    need(native.observation?.terminal === true && native.observation.outcome === 'SUCCEEDED' &&
      native.observation.image_id === plan.request.artifact_image_id && /^[0-9a-f]{64}$/.test(native.digest));
    const doors=receipts.BUILD.data.database_doors, rows=await this.catalogue(doors.names);
    need(catalogueDigest(rows) === receipts.READINESS.data.database_contract_digest);
    const health=await this.publicJSON('https://engine.smarter.poker/health');
    need(health.running === true && health.liveness === 'ok' && health.releaseSha === plan.request.source_sha &&
      health.maintenance?.policyVersion === 2 && health.maintenance.policyDigest === operationPolicyDigest &&
      health.maintenance.activationReceipt === receipts.READINESS.data.maintenance_activation_receipt &&
      health.maintenance.operation?.operationId === input.operation_id);
    const nativeRef=`native-proof-sha256:${native.digest}`;
    const receipt=await maintenanceCall(this.client,'register_maintenance_safe_resume',[input.operation_id,publication.id,{
      policy_digest:operationPolicyDigest,source_sha:plan.request.source_sha,image_id:plan.request.artifact_image_id,
      readiness_event:receipts.READINESS.event_id,schema_compatible:true,retained_recovery_compatible:true,
      checks:{native_seal:[nativeRef],local_runtime:[nativeRef],public_runtime:[nativeRef],database_leader:[nativeRef],retired_writers:[nativeRef],
        schema:[`catalogue-sha256:${catalogueDigest(rows)}`],retained_recovery:[nativeRef,...native.recovery.receipt_refs]}
    },this.actor]);
    return {receipt_id:receipt};
  }
}

// The controller can request verification but never receives this process's DB credential.
// Native socket permissions and independent existing service identity are installed gates.
export function verifierClient(socketPath) {
  need(socketPath === '/run/club-arena-maintenance-verifier.sock');
  return input => new Promise((resolve,reject)=>{
    const socket=socketConnect(socketPath); let body='',bytes=0;
    socket.setTimeout(30000,()=>socket.destroy(new Error('RELEASE_VERIFIER_TIMEOUT')));
    socket.on('error',()=>reject(new Error('RELEASE_VERIFIER_UNAVAILABLE')));
    socket.on('connect',()=>socket.end(JSON.stringify(input)+'\n'));
    socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)socket.destroy();else body+=chunk.toString();});
    socket.on('end',()=>{try{const value=JSON.parse(body);need(uuid.test(value.receipt_id));resolve(value);}catch{reject(new Error('RELEASE_VERIFIER_REFUSED'));}});
  });
}
async function main() {
  const {config}=await installedConfiguration(process.argv[2]); const v=config.maintenance_verifier;
  need(v && process.env.CREDENTIALS_DIRECTORY && /^[a-z][a-z0-9_-]{0,50}$/.test(v.database_credential_name));
  const connectionString=(await readFile(path.join(process.env.CREDENTIALS_DIRECTORY,v.database_credential_name),'utf8')).trim();
  const client=await connect({connectionString,ssl:{ca:await rootOwnedFile(v.database_ca_path),rejectUnauthorized:true}});
  try {
    const role=(await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
      pg_has_role(session_user,'release_journal_verifier','member') AS verifier,
      pg_has_role(session_user,'release_journal_controller','member') AS controller FROM pg_roles WHERE rolname=session_user`)).rows[0];
    need(client.connection.stream.authorized === true && role.rolname === v.database_principal && role.rolcanlogin && role.verifier &&
      !role.controller && !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole && !role.rolcreatedb && !role.rolreplication);
    need(v.protocol===2);
    const nativeProof=engineTransport(v.host_alias,undefined,v.protocol), intake=new HetznerIntakeAdapter({controlSha:v.control_sha,request:nativeProof});
    const catalogue=names=>readDoorCatalogue(client,names), readiness=new EngineReadiness({catalogue,intake});
    let raw='',bytes=0; process.stdin.setEncoding('utf8');
    const deadline=setTimeout(()=>process.stdin.destroy(new Error('RELEASE_VERIFIER_TIMEOUT')),5000);
    try { for await(const chunk of process.stdin){bytes+=Buffer.byteLength(chunk);need(bytes<=4096);raw+=chunk;} } finally {clearTimeout(deadline);}
    console.log(JSON.stringify(await new MaintenanceVerifier({client,readiness,nativeProof,catalogue}).verify(JSON.parse(raw))));
  } finally {await client.end();}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(()=>{console.log(JSON.stringify({error:'RELEASE_VERIFIER_REFUSED'}));process.exitCode=1;});
