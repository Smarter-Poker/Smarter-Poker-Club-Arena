import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {Client}=require(process.argv[2]);
if(!process.env.PGHOST?.startsWith('/'))throw Error('Native socket only');
const a=new Client(),b=new Client();const actor='2d1cd6c3-5700-4af9-a271-d4863fdab20d',op='eece5c98-1bd4-45c5-a6d8-5a637c9a782c';let saved;
try{
 await a.connect();await b.connect();
 await a.query(`SET request.jwt.claims='{"role":"service_role","sub":"${actor}"}';BEGIN ISOLATION LEVEL REPEATABLE READ;`);
 const r=await a.query("SELECT to_jsonb(h) h FROM public.ca_operator_floor_hold h WHERE operation_id='a970faa8-7a40-4af9-9096-51d8c67ca803'");if(r.rows.length!==1)throw Error('Owned original hold missing');saved=r.rows[0].h;
 await b.query('BEGIN;SELECT pg_advisory_xact_lock(530093);DELETE FROM public.ca_operator_floor_hold;COMMIT;');
 let refused=false;try{await a.query('SELECT public.fn_ca_launch_cache_stage($1,$2,$3)',[op,'b'.repeat(64),actor]);}catch(e){if(e.code!=='40001')throw e;refused=true;}
 if(!refused)throw Error('Stale original hold admitted');
 await a.query('ROLLBACK');
 await b.query('INSERT INTO public.ca_operator_floor_hold SELECT * FROM jsonb_populate_record(NULL::public.ca_operator_floor_hold,$1)',[JSON.stringify(saved)]);saved=null;
 console.log(JSON.stringify({actual_two_connection_stale_hold_refused:true,sqlstate:'40001',unchanged_original_hold_restored:true}));
}finally{await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});if(saved)await b.query('INSERT INTO public.ca_operator_floor_hold SELECT * FROM jsonb_populate_record(NULL::public.ca_operator_floor_hold,$1)',[JSON.stringify(saved)]).catch(()=>{});await a.end().catch(()=>{});await b.end().catch(()=>{});}
