import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// All GC runs in synthetic targets inside this network-isolated container.
it.skipIf(process.platform !== 'linux')(
  'preserves checkpoint Promise custody and final receipt margin on exact production Node',
  () => {
    const image =
      'node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
    const name = 'checkpoint-promise-custody-' + randomUUID();
    const labelKey = 'smarter-poker.test.checkpoint-promise';
    let attempted = false;
    const script = String.raw`
      const assert=require('node:assert/strict');
      const {spawnSync}=require('node:child_process');
      assert.equal(process.version,'v22.23.2');
      const results=[];
      for(const scenario of ['promise_gc','promise_gc_settle','receipt_deadline','receipt_publication']) {
        const child=spawnSync(process.execPath,[
          'tests/operations/legacy-checkpoint-transport.mjs',scenario,
          'file:///repository/server/scripts/legacy-engine-checkpoint.mjs'
        ],{encoding:'utf8',timeout:12000,maxBuffer:32768,
           env:{PATH:'/usr/local/bin:/usr/bin:/bin',TZ:'UTC',TMPDIR:'/tmp'}});
        assert.equal(child.error?.message??null,null,child.stderr);
        assert.equal(child.status,0,child.stdout+child.stderr);
        const result=JSON.parse(child.stdout.trim());
        assert.equal(result.ok,true);assert.equal(result.scenario,scenario);
        assert.equal(result.node,'v22.23.2');
        if(scenario==='receipt_publication') {
          assert.equal(result.backpressureFlushed,true);
          assert.equal(result.blockedPublicationBounded,true);
          assert.equal(result.closedReaderRefused,true);
          results.push(result);continue;
        }
        if(scenario!=='receipt_deadline')assert.equal(result.gcCalls,1);
        else {
          assert.ok(result.receiptRemainingMs>=500);
          assert.equal(result.checkpointResult.ok,false);
          assert.equal(result.checkpointResult.reason,'inspector cleanup not verified');
          assert.equal(result.checkpointResult.retryAllowed,false);
          assert.equal(result.checkpointResult.inspectorClosed,false);
          assert.equal(result.nativeShutdownRequests,1);
          assert.equal(result.clientCloseCalls,0);
          assert.match(result.checkpointResult.transportDetail,/^op=guardAwait,cause=request_timeout,/);
        }
        assert.equal(result.guardRequests,1);assert.equal(result.guardAwaitRequests,1);
        if(scenario!=='receipt_deadline')assert.deepEqual(result.nativeProtocolErrors,[]);
        assert.equal(result.sameProcessAliveAfterCleanup,true);
        assert.equal(result.portClosed,true);assert.equal(result.normalExit,true);
        results.push(result);
      }
      console.log(JSON.stringify({ok:true,node:process.version,results}));
    `;
    try {
      const pull = spawnSync('docker', ['pull', image], {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 1048576,
        killSignal: 'SIGKILL',
      });
      expect(pull.error?.message ?? null, pull.stderr).toBeNull();
      expect(pull.status, pull.stdout + pull.stderr).toBe(0);
      attempted = true;
      const native = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--label',
          labelKey + '=' + name,
          '--network',
          'none',
          '--read-only',
          '--tmpfs',
          '/tmp:rw,nosuid,size=33554432',
          '--mount',
          'type=bind,source=' + resolve('..') + ',target=/repository,readonly',
          '--workdir',
          '/repository',
          image,
          'node',
          '-e',
          script,
        ],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 131072, killSignal: 'SIGKILL' }
      );
      expect(native.error?.message ?? null, native.stderr).toBeNull();
      expect(native.status, native.stdout + native.stderr).toBe(0);
      expect(JSON.parse(native.stdout.trim())).toMatchObject({
        ok: true,
        node: 'v22.23.2',
        results: [
          { scenario: 'promise_gc' },
          { scenario: 'promise_gc_settle' },
          { scenario: 'receipt_deadline' },
          { scenario: 'receipt_publication' },
        ],
      });
    } finally {
      if (attempted) {
        // A timed-out Docker client does not prove its unique fixture exited.
        const deadline = Date.now() + 5000;
        const docker = (args: string[]) => {
          const remaining = deadline - Date.now();
          expect(remaining).toBeGreaterThan(0);
          const result = spawnSync('docker', args, {
            encoding: 'utf8',
            timeout: remaining,
            maxBuffer: 32768,
            killSignal: 'SIGKILL',
          });
          expect(result.error?.message ?? null, result.stderr).toBeNull();
          expect(result.status, result.stderr).toBe(0);
          return result.stdout.trim();
        };
        const filter = ['ps', '-aq', '--no-trunc', '--filter', 'name=^/' + name + '$'];
        const ids = docker(filter);
        if (ids) {
          expect(ids).toMatch(/^[a-f0-9]{64}$/);
          const owned = JSON.parse(docker(['inspect', '--format', '{{json .}}', ids]));
          expect(owned.Id).toBe(ids);
          expect(owned.Name).toBe('/' + name);
          expect(owned.Config.Labels[labelKey]).toBe(name);
          docker(['rm', '-f', ids]);
        }
        expect(docker(filter)).toBe('');
      }
    }
  },
  165000
);
