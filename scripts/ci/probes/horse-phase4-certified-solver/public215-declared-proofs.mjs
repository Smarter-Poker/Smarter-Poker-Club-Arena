// Print only trusted readback SQL from this exact maintained migration.
import{readFileSync}from'node:fs';
const source=readFileSync(new URL('../../../../supabase/migrations/20261029070812_public_hist215_models_bind_independent_exact_public_state.sql',import.meta.url),'utf8');
const proofs=[...source.matchAll(/^-- @live-proof: (.+)$/gm)].map(m=>m[1]);
if(proofs.length!==6)throw Error('PUBLIC215_EXACT_SIX_INSTALL_READBACKS_REQUIRED');
for(let i=0;i<proofs.length;i++)console.log(`DO $readback$ BEGIN IF NOT COALESCE((${proofs[i]}),false)THEN RAISE EXCEPTION 'public215 declared installed identity ${i+1} differs';END IF;END $readback$;`);
console.log("SELECT 'PUBLIC215_DECLARED_INSTALLED_IDENTITIES_PASS'AS result;");
