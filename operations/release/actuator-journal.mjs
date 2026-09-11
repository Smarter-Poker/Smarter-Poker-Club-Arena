#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './journal.mjs';
import { maintenanceCall } from './maintenance-journal.mjs';
import { installedConfiguration, rootOwnedFile } from './installed-bundle.mjs';
const need=v=>{if(!v)throw new Error('RELEASE_ACTUATOR_AUTHORITY_REFUSED');};
export async function actuatorAuthority(client,input,bundleDigest) {
  need(input && ['context','consume'].includes(input.action) && /^[0-9a-f-]{36}$/.test(input.provider_operation_id));
  if(input.action==='context') return maintenanceCall(client,'engine_maintenance_actuator_context',[input.provider_operation_id]);
  need(['owner','epoch','operation_id','step_id'].every(k=>/^[0-9a-f-]{36}$/.test(input[k])));
  return maintenanceCall(client,'consume_engine_maintenance_step',[input.owner,input.epoch,input.operation_id,input.step_id,
    input.provider_operation_id,bundleDigest,'installed-engine-operation-v2']);
}
async function main() {
  const {config,installation}=await installedConfiguration(process.argv[2]), a=config.engine_actuator;
  need(a && process.env.CREDENTIALS_DIRECTORY && /^[a-z][a-z0-9_-]{0,50}$/.test(a.database_credential_name));
  const connectionString=(await readFile(path.join(process.env.CREDENTIALS_DIRECTORY,a.database_credential_name),'utf8')).trim();
  const client=await connect({connectionString,ssl:{ca:await rootOwnedFile(a.database_ca_path),rejectUnauthorized:true}});
  try {
    const role=(await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
      pg_has_role(session_user,'release_journal_actuator','member') AS actuator,
      pg_has_role(session_user,'release_journal_controller','member') AS controller FROM pg_roles WHERE rolname=session_user`)).rows[0];
    need(client.connection.stream.authorized===true && role.rolname===a.database_principal && role.rolcanlogin && role.actuator &&
      !role.controller && !role.rolsuper && !role.rolbypassrls && !role.rolcreaterole && !role.rolcreatedb && !role.rolreplication);
    let raw='',bytes=0;process.stdin.setEncoding('utf8');
    for await(const chunk of process.stdin){bytes+=Buffer.byteLength(chunk);need(bytes<=4096);raw+=chunk;}
    console.log(JSON.stringify(await actuatorAuthority(client,JSON.parse(raw),installation.bundle_digest)));
  } finally {await client.end();}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(()=>{console.log(JSON.stringify({error:'RELEASE_ACTUATOR_AUTHORITY_REFUSED'}));process.exitCode=1;});
