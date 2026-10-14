import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {Client}=require(process.argv[2]);
if(!process.env.PGHOST?.startsWith('/'))throw Error('Native socket only');
const a=new Client(),b=new Client();const actor='2d1cd6c3-5700-4af9-a271-d4863fdab20d',op='eece5c98-1bd4-45c5-a6d8-5a637c9a782c';
try{
 await a.connect();await b.connect();
 await a.query(`SET request.jwt.claims='{"role":"service_role","sub":"${actor}"}';BEGIN;`);
 await a.query(`SELECT public.fn_ca_launch_reset_capture($1,$2,$3)`,[op,'b'.repeat(64),actor]);
 await a.query('SELECT public.fn_ca_launch_accounting_activate($1)',[op]);
 await b.query("BEGIN;SET LOCAL lock_timeout='250ms';");
 let refused=false;try{await b.query("INSERT INTO public.club_member_daily_stats(club_id,table_id,user_id,stat_date) VALUES('a0000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001','ffffffff-ffff-ffff-ffff-ffffffffffff','2026-10-11')");}catch(e){if(e.code!=='55P03')throw e;refused=true;}
 if(!refused)throw Error('Unarchived late writer admitted');
 await b.query('ROLLBACK');await a.query('ROLLBACK');
 const r=await a.query("SELECT count(*)::int n FROM public.club_member_daily_stats WHERE user_id='ffffffff-ffff-ffff-ffff-ffffffffffff'");
 if(r.rows[0].n!==0)throw Error('Unarchived late write persisted');
 console.log(JSON.stringify({actual_two_connection_late_insert_refused:true,sqlstate:'55P03',no_unarchived_loss:true}));
}finally{await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});await a.end().catch(()=>{});await b.end().catch(()=>{});}
