#!/usr/bin/env node

const required = (name) => {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const supabaseUrl = required('SUPABASE_URL').replace(/\/$/, '');
const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
const clientSha = required('CLIENT_SHA');
const engineSha = required('ENGINE_SHA');
const fullSha = /^[0-9a-f]{40}$/;

if (!fullSha.test(clientSha) || !fullSha.test(engineSha)) {
  throw new Error('CLIENT_SHA and ENGINE_SHA must be full lowercase Git commit identities');
}

const response = await fetch(
  `${supabaseUrl}/rest/v1/rpc/fn_seal_phase_one_customization_cutover`,
  {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_client_sha: clientSha, p_engine_sha: engineSha }),
  }
);

const body = await response.text();
if (!response.ok) {
  throw new Error(`Phase 1 cutover seal was refused (${response.status}): ${body.slice(0, 800)}`);
}

let result;
try {
  result = JSON.parse(body);
} catch {
  throw new Error('Phase 1 cutover seal returned malformed JSON');
}
if (!result || result.sealed !== true) {
  throw new Error('Phase 1 cutover seal did not confirm a durable receipt');
}

console.log(
  `Phase 1 customization cutover sealed: client=${clientSha} engine=${engineSha}`
);
