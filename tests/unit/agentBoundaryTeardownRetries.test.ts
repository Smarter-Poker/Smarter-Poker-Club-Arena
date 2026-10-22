import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/*
 * Run 39694814807 (2026-10-21): the agent boundary qualification's teardown
 * DELETE of its own agent fixture hit a statement timeout (57014) once and was
 * never asked again. The agent row stayed, the account cleanup door refused
 * CERTIFICATION_PROTECTED_MEMBERSHIP_HAS_AUTHORITY_OR_CUSTODY, and the reserved
 * PostDeploy identity sat in KINGS CLUB and Deep Stack Society for two hours.
 *
 * This runs the real script against a scripted database whose first agent
 * DELETE times out and whose qualification body fails, and proves the teardown
 * still removes the agent and restores the admin role. A definitive refusal on
 * the same DELETE must still fail the teardown and must not be retried.
 */

const SCRIPT = resolve(__dirname, '../../scripts/ci/qualify-agent-boundary.mjs');
const ACCOUNT_ID = '7cfec1d3-5484-436f-aeb9-cc0cd58d902e';
const CLUB = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';

function fakeDatabase(deleteFailure: { status: number; code: string }) {
  return `
const ACCOUNT_ID=${JSON.stringify(ACCOUNT_ID)};
const state={role:'admin',agent:null,deleteAttempts:0};
const json=(status,body)=>new Response(body===undefined?null:JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
globalThis.__state=state;
process.on('exit',()=>{process.stdout.write('\\nSTATE '+JSON.stringify(state)+'\\n');});
globalThis.fetch=async(url,init={})=>{
 const u=new URL(String(url));const method=init.method||'GET';const p=u.pathname;
 if(p==='/rest/v1/club_members'&&method==='GET'&&u.searchParams.get('agent_id')) return json(200,[]);
 if(p==='/rest/v1/club_members'&&method==='GET') return json(200,[{user_id:ACCOUNT_ID,role:state.role,status:'active',agent_id:null,parent_agent_id:null,chip_balance:0,promo_balance:0,held_chips:0,locked_chips:0,credit_used:0,credit_limit:0}]);
 if(p==='/rest/v1/club_members'&&method==='PATCH'){const b=JSON.parse(init.body);state.role=b.role;return json(200,[{user_id:ACCOUNT_ID}]);}
 if(p==='/rest/v1/profiles') return json(200,[{email:'ca-customization-cert-postdeploy-test@example.invalid',role:'user',is_admin:false,is_horse:false}]);
 if(p==='/auth/v1/token') return json(200,{access_token:'token',user:{id:ACCOUNT_ID}});
 if(p==='/auth/v1/logout') return json(204);
 if(p==='/rest/v1/agents'&&method==='POST'){
  // The insert commits, then the qualification body fails on its first role change.
  const b=JSON.parse(init.body);state.agent={id:b.id,user_id:ACCOUNT_ID,parent_agent_id:null,credit_used:0,credit_limit:0,business_balance:0,player_balance:0,promo_balance:0,agent_wallet_balance:0,player_wallet_balance:0,promo_wallet_balance:0,total_players:0,active_player_count:0,sub_agent_count:0,weekly_rake_generated:0,lifetime_earnings:0,lifetime_rake_generated:0};
  return json(201,[state.agent]);
 }
 if(p==='/rest/v1/agents'&&method==='GET'){
  if(u.searchParams.get('parent_agent_id')) return json(200,[]);
  if(u.searchParams.get('id')) return json(200,state.agent?[state.agent]:[]);
  return json(200,[]);
 }
 if(p==='/rest/v1/agents'&&method==='PATCH') return json(500,{code:'P0001',message:'qualification body failure'});
 if(p==='/rest/v1/agents'&&method==='DELETE'){
  state.deleteAttempts+=1;
  if(state.deleteAttempts===1) return json(${deleteFailure.status},{code:${JSON.stringify(deleteFailure.code)},message:'first delete fails'});
  state.agent=null;return json(204);
 }
 return json(404,{code:'TEST',message:'unexpected '+method+' '+p});
};
`;
}

function run(deleteFailure: { status: number; code: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-boundary-'));
  const mock = join(dir, 'fake-database.mjs');
  writeFileSync(mock, fakeDatabase(deleteFailure));
  const accountFile = join(dir, 'account.json');
  writeFileSync(
    accountFile,
    JSON.stringify({
      id: ACCOUNT_ID,
      email: 'ca-customization-cert-postdeploy-test@example.invalid',
      password: 'not-a-real-password',
    })
  );
  const result = spawnSync(process.execPath, ['--import', mock, SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      SUPABASE_URL: 'https://fake-database.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_fake',
      VITE_SUPABASE_ANON_KEY: 'sb_publishable_fake',
      E2E_TEST_ACCOUNT_FILE: accountFile,
      E2E_CLUB_ID: CLUB,
    },
  });
  const line = result.stdout.split('\n').find((l) => l.startsWith('STATE '));
  const state = line ? JSON.parse(line.slice(6)) : null;
  return { status: result.status, stderr: result.stderr, state };
}

describe('agent boundary teardown', () => {
  it('retries a statement timeout on the fixture DELETE and leaves no agent behind', () => {
    const { status, stderr, state } = run({ status: 500, code: '57014' });
    // The qualification body still fails, and says so.
    expect(status).not.toBe(0);
    expect(stderr).toContain('code P0001');
    expect(stderr).toContain('agent boundary teardown: remove agent fixture failed transiently');
    // The teardown nevertheless removed the fixture and restored the role.
    expect(state).toEqual({ role: 'admin', agent: null, deleteAttempts: 2 });
  }, 60_000);

  it('does not retry a definitive refusal on the fixture DELETE', () => {
    const { status, stderr, state } = run({ status: 500, code: '55000' });
    expect(status).not.toBe(0);
    expect(stderr).toContain('code 55000');
    expect(state.deleteAttempts).toBe(1);
    expect(state.agent).not.toBeNull();
  }, 60_000);

  it('keeps the timeout incident documented beside the teardown', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("from './transient-retry.mjs'");
    expect(source).toContain('39694814807');
  });
});
