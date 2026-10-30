import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import './protection-applicability.test.mjs';
import './revision-boundaries.test.mjs';
import './producer-boundary.test.mjs';

const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const lines = workflow.split('\n');
const name = '      - name: Supabase Invariants - A Money Trigger Declares Itself';
const start = lines.indexOf(name);
assert.notEqual(start, -1, 'the actual money-trigger workflow step must exist');
const run = lines.findIndex((line, index) => index > start && line === '        run: |');
assert.notEqual(run, -1, 'the actual step must retain a literal shell body');
const body = [];
for (const line of lines.slice(run + 1)) {
  if (line.trim() && !line.startsWith('          ')) break;
  body.push(line.slice(10));
}
const header = lines.slice(start, run).join('\n');
const strict = 'scripts/ci/check-money-trigger-declared.mjs';
const protection = 'scripts/ci/assert-money-trigger-protection.mjs';

// Exercise the maintained workflow shell verbatim. Only child outcomes are
// controlled: no real GitHub request, credential, SQL, dispatch or proof is used.
function invoke({ checker = 0, guard = 0, tee = 0, signal = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-trigger-caller-'));
  try {
    const calls = path.join(dir, 'calls');
    const summary = path.join(dir, 'summary');
    const harness = [
      'node() {',
      '  printf "%s\\n" "$*" >> "$CALL_LOG"',
      '  case "$1" in',
      '    scripts/ci/check-money-trigger-declared.mjs)',
      '      if [ "$CHECKER_SIGNAL" = "1" ]; then',
      '        (exec sh -c \'kill -TERM $$\')',
      '      else',
      '        return "$CHECKER_STATUS"',
      '      fi ;;',
      '    scripts/ci/assert-money-trigger-protection.mjs)',
      '      [ "$GITHUB_TOKEN" = "modeled-standard-token" ] || return 99',
      '      [ "$MONEY_TRIGGER_REPORTER_APP_ID" = "4962039" ] || return 99',
      '      return "$GUARD_STATUS" ;;',
      '    *) return 98 ;;',
      '  esac',
      '}',
      'tee() { cat; return "$TEE_STATUS"; }',
      ...body,
    ].join('\n');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', harness], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        CALL_LOG: calls,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_TOKEN: 'modeled-standard-token',
        MONEY_TRIGGER_REPORTER_APP_ID: '4962039',
        CHECKER_STATUS: String(checker),
        CHECKER_SIGNAL: signal ? '1' : '0',
        GUARD_STATUS: String(guard),
        TEE_STATUS: String(tee),
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, result.stderr);
    return {
      status: result.status,
      calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [],
      summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ordinary same-file success does not request historical protection', () => {
  const result = invoke({ guard: 1 });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [strict]);
});

test('literal policy refusal delegates only to mandatory App-bound protection', () => {
  const result = invoke({ checker: 1 });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [strict, protection]);
  assert.match(result.summary, /independently required.*App.*verdict/i);
  assert.doesNotMatch(result.summary, /every trigger.*declares itself/i);
});

for (const guard of [1, 127]) {
  test('policy refusal cannot pass failed or unavailable protection: ' + guard, () => {
    const result = invoke({ checker: 1, guard });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, [strict, protection]);
  });
}

for (const checker of [2, 3, 127]) {
  test('unreadable or unknown checker result cannot delegate: ' + checker, () => {
    const result = invoke({ checker });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, [strict]);
  });
}

test('terminated checker cannot delegate', () => {
  const result = invoke({ signal: true });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls, [strict]);
});

for (const checker of [0, 1]) {
  test('a log pipeline failure is not policy exit 1: checker ' + checker, () => {
    const result = invoke({ checker, tee: 1 });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, [strict]);
  });
}

test('actual caller binds only the standard token and configured public App identity', () => {
  assert.match(header, /^        env:\n          GITHUB_TOKEN: \$\{\{ github\.token \}\}\n          MONEY_TRIGGER_REPORTER_APP_ID: \$\{\{ vars\.MONEY_TRIGGER_REPORTER_APP_ID \}\}$/m);
  assert.doesNotMatch(header, /secrets\.|PRIVATE_KEY|REPORTER_TOKEN/);
});

test('caller regression is enforced by the existing pull-request repository check job', () => {
  const job = workflow.split('\n  typecheck_compile:\n')[1]?.split(/\n  [a-z_]+:\n/)[0];
  assert.ok(job, 'the existing repository-check job must exist');
  assert.match(job, /if: github\.event_name == 'pull_request'/);
  assert.match(job, /run: node --test tests\/money-trigger-ci-caller\.test\.mjs/);
});

test('actual readonly CLI defers an applicable ruleset with GitHub-hidden bypass metadata', () => {
  const source = new URL('../scripts/ci/assert-money-trigger-protection.mjs', import.meta.url);
  const script = `
    process.env.GITHUB_REPOSITORY = 'Smarter-Poker/Smarter-Poker-Club-Arena';
    process.env.GITHUB_REPOSITORY_ID = '1132369872';
    process.env.GITHUB_TOKEN = 'modeled-standard-token';
    process.env.MONEY_TRIGGER_REPORTER_APP_ID = '4962039';
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/rulesets/21163380' ||
          options.headers.Authorization !== 'Bearer modeled-standard-token') throw Error('unexpected request');
      return {ok:true,json:async()=>({target:'branch',enforcement:'active',conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},rules:[{type:'required_status_checks',parameters:{required_status_checks:[{context:'Money trigger declaration authority',integration_id:4962039}]}}]})};
    };
    process.argv[1] = ${JSON.stringify(source.pathname)};
    await import(${JSON.stringify(source.href)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000, env: {PATH: process.env.PATH},
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DEFERRED/);
  assert.doesNotMatch(result.stdout, /no-bypass.*(?:verified|certified)/i);
});

const trustedWorkflow = fs.readFileSync(new URL('../.github/workflows/money-trigger-recovery.yml', import.meta.url), 'utf8');
function trustedStep(name) {
  const step = trustedWorkflow.split('      - name: ' + name + '\n')[1];
  assert.ok(step, 'missing trusted workflow step ' + name);
  return step.split(/\n      - (?:name:|uses:)/)[0];
}
test('privileged reader stays in trusted default-main finish and retains cancellation cleanup', () => {
  assert.match(trustedWorkflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(trustedWorkflow, /environment: money-trigger-recovery-trusted/);
  assert.match(trustedWorkflow, /persist-credentials: false/);
  const mint = trustedStep('Mint short-lived protection reader');
  assert.match(mint, /if: success\(\) && github\.event_name == 'pull_request_target'/);
  assert.match(mint, /app-id: '4680372'/);
  assert.match(mint, /private-key: \$\{\{ secrets\.AUTOPILOT_APP_PRIVATE_KEY \}\}/);
  assert.match(mint, /owner: \$\{\{ github\.repository_owner \}\}\n          repositories: Smarter-Poker-Club-Arena/);
  assert.deepEqual([...mint.matchAll(/permission-([\w-]+): (\w+)/g)].map(m => [m[1],m[2]]), [['administration','write']]);
  assert.match(mint, /skip-token-revoke: false/);
  assert.match(trustedStep('Finish explicit captured-head check'), /PROTECTION_READER_TOKEN: \$\{\{ steps\.protection-reader\.outputs\.token \}\}/);
  assert.equal((trustedWorkflow.match(/PROTECTION_READER_TOKEN:/g)||[]).length, 1);
  assert.doesNotMatch(trustedStep('Verify exact live recovery with trusted code'), /protection-reader|PROTECTION_READER_TOKEN|AUTOPILOT/);
  assert.match(trustedStep('Mint check-only reporter'), /app-id: \$\{\{ vars\.MONEY_TRIGGER_REPORTER_APP_ID \}\}/);
  assert.match(trustedStep('Mint check-only reporter'), /permission-checks: write/);
  assert.ok(trustedWorkflow.indexOf('Mint short-lived protection reader') > trustedWorkflow.indexOf('run: node scripts/ci/produce-money-trigger-recovery.mjs'));
});

// Execute the actual trusted finish CLI with a closed fake transport: every
// request must use its intended identity and an unexpected request throws.
function finish(kind, repository = 'Smarter-Poker/Smarter-Poker-Club-Arena') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-trigger-finish-'));
  try {
    const source = new URL('../scripts/ci/money-trigger-check-report.mjs', import.meta.url);
    const head = 'a'.repeat(40), now = Date.now();
    fs.writeFileSync(path.join(dir, 'money-trigger-check-state.json'), JSON.stringify({id:321,head,appId:'4962039',pr:7,runId:kind==='wrong-captured-run'?'5678':'1234'}));
    fs.writeFileSync(path.join(dir, 'money-trigger-recovery.json'), JSON.stringify({headSha:head,runId:kind==='wrong-sql-run'?'5678':'1234',results:[{recovered:true}],catalogObservedAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString()}));
    const script = `
      import fs from 'node:fs';
      const calls=[],kind=${JSON.stringify(kind)},head=${JSON.stringify(head)};
      globalThis.fetch = async (url,init={})=>{
        const method=init.method||'GET'; calls.push(method+' '+url);
        fs.writeFileSync('requests.json',JSON.stringify(calls));
        const expectToken=(token)=>{if(init.headers.Authorization!=='Bearer '+token)throw Error('wrong request identity')};
        if(url==='https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/rulesets/21163380'){
          expectToken('modeled-reader-token');
          if(method!=='GET')throw Error('ruleset mutation forbidden');
          if(kind==='read-throws')throw Error('modeled transport failure');
          return {ok:kind!=='read-denied',status:403,json:async()=>{
            if(kind==='bad-json')throw Error('modeled malformed response');
            const rule={target:'branch',enforcement:'active',bypass_actors:[],conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},rules:[{type:'required_status_checks',parameters:{required_status_checks:[{context:'Money trigger declaration authority',integration_id:4962039}]}}]};
            if(kind==='hidden-bypass')delete rule.bypass_actors;
            if(kind==='nonempty-bypass')rule.bypass_actors=[{actor_id:1}];
            if(kind==='unbound')rule.rules=[];
            return rule;
          }};
        }
        if(url==='https://api.github.com/installation/token'){
          expectToken('modeled-reader-token');if(method!=='DELETE')throw Error('wrong revoke method');
          return {status:kind==='revoke-denied'?403:204};
        }
        if(url==='https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls/7'){
          expectToken('modeled-standard-token');if(method!=='GET')throw Error('PR mutation forbidden');
          if(process.env.PROTECTION_READER_TOKEN)throw Error('reader leaked into check writer');
          return {ok:true,json:async()=>({state:'open',head:{sha:kind==='head-advance'?'b'.repeat(40):head}})};
        }
        if(url==='https://api.github.com/repos/Smarter-Poker/Smarter-Poker-Club-Arena/check-runs/321'){
          expectToken('modeled-reporter-token');if(method!=='PATCH')throw Error('wrong report method');
          if(process.env.PROTECTION_READER_TOKEN)throw Error('reader leaked into check writer');
          const body=JSON.parse(init.body);fs.writeFileSync('patch.json',JSON.stringify(body));
          return {ok:true,json:async()=>({head_sha:head,app:{id:4962039},conclusion:body.conclusion})};
        }
        throw Error('unexpected request');
      };
      process.argv=[process.execPath,${JSON.stringify(source.pathname)},'finish'];
      await import(${JSON.stringify(source.href)});
    `.replaceAll('Smarter-Poker/Smarter-Poker-Club-Arena',repository);
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH,GITHUB_REPOSITORY:repository,GITHUB_REPOSITORY_ID:'1132369872',GITHUB_RUN_ID:'1234',PR_NUMBER:'7',REPORTER_APP_ID:'4962039',REPORTER_TOKEN:'modeled-reporter-token',GITHUB_TOKEN:'modeled-standard-token',PROTECTION_READER_TOKEN:kind==='missing-token'?'':'modeled-reader-token',VERIFY_OUTCOME:kind==='sql-failed'?'failure':'success'}});
    assert.equal(result.error,undefined);
    assert.equal(result.signal,null,result.stderr);
    return {status:result.status,stderr:result.stderr,patch:JSON.parse(fs.readFileSync(path.join(dir,'patch.json'),'utf8')),calls:JSON.parse(fs.readFileSync(path.join(dir,'requests.json'),'utf8'))};
  } finally {fs.rmSync(dir,{recursive:true,force:true})}
}
test('trusted finish revokes the reader and rereads captured head before exact App success',()=>{
  const result=finish('success');assert.equal(result.status,0,result.stderr);assert.equal(result.patch.conclusion,'success');
  assert.deepEqual(result.calls.map(x=>x.split(' ')[0]),['GET','DELETE','GET','PATCH']);
  assert.match(result.calls[0],/rulesets\/21163380$/);assert.match(result.calls[1],/installation\/token$/);assert.match(result.calls[2],/pulls\/7$/);
});
for(const kind of ['read-denied','read-throws','bad-json','hidden-bypass','nonempty-bypass','unbound','revoke-denied','missing-token','head-advance','sql-failed','wrong-captured-run','wrong-sql-run'])test('actual trusted finish cannot report success: '+kind,()=>{
  const result=finish(kind);assert.equal(result.status,1,result.stderr);assert.equal(result.patch.conclusion,'failure');
  if(kind!=='missing-token')assert.match(result.calls[1],/^DELETE .*installation\/token$/);
});

// Transfer trust remains anchored to one immutable repository, with no wildcard owner.
import {isClubArenaRepository} from '../scripts/ci/repository-identity.mjs';
test('approved transferred repository reports the same protected App check',()=>{const r=finish('success','Smarter-Software-PIQ/Smarter-Poker-Club-Arena');assert.equal(r.status,0,r.stderr);assert.equal(r.patch.conclusion,'success')});
for(const repo of ['Smarter-Poker/Smarter-Poker-Club-Arena','Smarter-Software-PIQ/Smarter-Poker-Club-Arena'])test('approved repository requires its immutable ID '+repo,()=>{assert.equal(isClubArenaRepository(repo,'1132369872'),true);for(const id of [undefined,'','1','11323698720'])assert.equal(isClubArenaRepository(repo,id),false)});
for(const repo of ['evil/Smarter-Poker-Club-Arena','Smarter-Software-PIQ/evil','smarter-software-piq/Smarter-Poker-Club-Arena'])test('same ID cannot authorize an unapproved full name '+repo,()=>assert.equal(isClubArenaRepository(repo,'1132369872'),false));

const approvedPaidRoute = /^\$\{\{ github\.repository_owner == 'Smarter-Software-PIQ' && github\.repository_id == '1132369872' && 'ca-linux-(?:[48]core|delivery)' \|\| 'ubuntu-(?:latest|24\.04)' \}\}$/;
const approvedNativeProfileRoute = "${{ github.repository_owner == 'Smarter-Software-PIQ' && github.repository_id == '1132369872' && vars.CA_REQUIRED_NATIVE_PROFILE == 'large' && 'ca-linux-8core' || 'ubuntu-latest' }}";
test('warm client routes are exact while paid financial runners keep the immutable repository guard',()=>{
  const warm={
    'ci.yml':new Set(['changes','source_windows','stub_gate','typecheck','typecheck_compile','unit_shards','unit','server','verdict','build','css-beats-e2e','diamond-playfield-e2e','css-beats-gate']),
    'publish-club-arena.yml':new Set(['publish-needed','client-tests','build-and-store']),
    'component-fixture-native-smoke.yml':new Set(),
  };
  for(const [file,expected] of Object.entries(warm)){
    const text=fs.readFileSync(new URL('../.github/workflows/'+file,import.meta.url),'utf8');let job;const seen=new Set();let count=0;
    for(const line of text.split('\n')){
      const key=/^  ([A-Za-z_][A-Za-z_0-9-]*):\s*$/.exec(line);if(key)job=key[1];
      const route=/^    runs-on: (.+)$/.exec(line);if(!route)continue;count++;
      if(expected.has(job)){assert.equal(route[1],'ubuntu-latest',job);seen.add(job)}
      else if(file==='ci.yml' && ['accounting_postgres','server_shards'].includes(job))assert.equal(route[1],approvedNativeProfileRoute,job);
      else assert.match(route[1],approvedPaidRoute,job);
    }
    assert.ok(count);assert.deepEqual([...seen].sort(),[...expected].sort());
  }
});
test('delivery pool admission rejects foreign owners, IDs and arbitrary runner labels',()=>{
  const route="${{ github.repository_owner == 'Smarter-Software-PIQ' && github.repository_id == '1132369872' && 'ca-linux-delivery' || 'ubuntu-latest' }}";
  assert.match(route,approvedPaidRoute);
  for(const bad of [route.replace('Smarter-Software-PIQ','foreign'),route.replace('1132369872','42'),route.replace('ca-linux-delivery','ca-linux-untrusted'),route.replace(" && github.repository_id == '1132369872'",'')])assert.doesNotMatch(bad,approvedPaidRoute);
});

test('local coordinator reads supported REST metadata and refuses another repository before dispatch',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'transfer-coordinator-'));
  try{
    const executable=path.join(dir,'gh');
    fs.writeFileSync(executable,'#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRANSFER_CALLS"\nprintf \'{"nameWithOwner":"Smarter-Software-PIQ/Smarter-Poker-Club-Arena","databaseId":999}\\n\'\n');
    fs.chmodSync(executable,0o700);
    const calls=path.join(dir,'calls');
    const result=spawnSync(process.execPath,[new URL('../scripts/ci/await-money-trigger-proof.mjs',import.meta.url).pathname],{cwd:dir,encoding:'utf8',env:{PATH:dir+path.delimiter+process.env.PATH,TRANSFER_CALLS:calls},timeout:5000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/Wrong Club Arena repository identity/);
    assert.equal(fs.readFileSync(calls,'utf8').trim(),'api repos/{owner}/{repo} --jq {nameWithOwner:.full_name,databaseId:.id}');
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('estate integrity reads split installations without moving issue writes or other repositories',()=>{
  const source=fs.readFileSync(new URL('../.github/scripts/estate-integrity.sh',import.meta.url),'utf8');
  const fn=/estate_gh_read\(\) \{[\s\S]*?\n\}\ngh_ro/.exec(source)?.[0].replace(/\ngh_ro$/,'');assert.ok(fn);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'estate-transfer-route-'));
  try{
    const executable=path.join(dir,'gh');fs.writeFileSync(executable,'#!/bin/sh\nprintf "%s|%s\\n" "$GH_TOKEN" "$*"\n');fs.chmodSync(executable,0o700);
    const invoke=(args,id='1132369872')=>spawnSync('bash',['--noprofile','--norc','-c',`${fn}\nHOME_REPO='Smarter-Software-PIQ/Smarter-Poker-Club-Arena'\nGITHUB_REPOSITORY_ID='${id}'\nGH_TOKEN=modeled-personal\nGH_TOKEN_CA=modeled-organization\nestate_gh_read ${args}`],{encoding:'utf8',env:{PATH:dir+path.delimiter+process.env.PATH},timeout:5000});
    assert.equal(invoke('api repos/Smarter-Poker/Smarter-Poker-Club-Arena/rulesets').stdout.trim(),'modeled-organization|api repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/rulesets');
    assert.equal(invoke('run list --repo Smarter-Poker/Smarter-Poker-Club-Arena').stdout.trim(),'modeled-organization|run list --repo Smarter-Software-PIQ/Smarter-Poker-Club-Arena');
    assert.equal(invoke('api repos/Smarter-Poker/Smarter-Poker-World-Hub/rulesets').stdout.trim(),'modeled-personal|api repos/Smarter-Poker/Smarter-Poker-World-Hub/rulesets');
    assert.notEqual(invoke('api repos/Smarter-Poker/Smarter-Poker-Club-Arena/rulesets','42').status,0);
    assert.match(source,/GH_TOKEN="\$\{GH_TOKEN_ISSUES:-\$\{GH_TOKEN:-\}\}" gh "\$@"/);
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('estate digest uses the organization token only for immutable transferred Club Arena reads',async()=>{
  const source=fs.readFileSync(new URL('../.github/scripts/estate-digest.mjs',import.meta.url),'utf8');
  const body=/const gh = async \(path, init = \{\}\) => \{([\s\S]*?)\n\};/.exec(source)?.[1];assert.ok(body);
  const route=new Function('REPO','TOKEN','process','ghWith','assertClubArenaRepository',`return async (path,init={})=>{${body}}`);
  const read=route('Smarter-Software-PIQ/Smarter-Poker-Club-Arena','modeled-personal',{env:{GITHUB_REPOSITORY_ID:'1132369872',GH_TOKEN_CA:'modeled-organization'}},token=>async path=>({token,path}),(repo,id)=>{assert.equal(isClubArenaRepository(repo,id),true)});
  assert.equal((await read('/repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/actions/runs')).token,'modeled-organization');
  assert.equal((await read('/repos/Smarter-Poker/Smarter-Poker-World-Hub/actions/runs')).token,'modeled-personal');
  assert.equal((await read('/repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena-fork/actions/runs')).token,'modeled-personal');
  for(const env of [{GITHUB_REPOSITORY_ID:'42',GH_TOKEN_CA:'modeled-organization'},{GITHUB_REPOSITORY_ID:'1132369872'}]){const refused=route('Smarter-Software-PIQ/Smarter-Poker-Club-Arena','modeled-personal',{env},()=>{throw Error('must refuse before credential use')},(repo,id)=>{assert.equal(isClubArenaRepository(repo,id),true)});await assert.rejects(refused('/repos/Smarter-Software-PIQ/Smarter-Poker-Club-Arena/actions/runs'));}
});
