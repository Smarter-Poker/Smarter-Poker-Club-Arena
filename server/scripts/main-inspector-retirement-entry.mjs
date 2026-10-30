// Concatenated with maintained transport and kernel qualification by immutable control.
import * as retirementFs from 'node:fs';
import * as retirementHttp from 'node:http';
import { createHash as retirementHash } from 'node:crypto';
const retirementDeadline = Number(process.argv[1]);
// All receipt/exit time is inside the supplied native deadline, itself inside
// the unchanged host20s. Keep100ms for normal exit and Docker forwarding.
const retirementWorkDeadline = retirementDeadline - 200;
let retirementPublishing = false;
async function retirementPublish(outcome, exitCode) {
  if (retirementPublishing) return;
  retirementPublishing = true;
  const available = retirementDeadline - Date.now() - 100;
  let written = false;
  if (Number.isSafeInteger(retirementDeadline) && available > 0) {
    written = await new Promise((resolve) => {
      let finished = false;
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (ok) process.stdout.removeListener('error', onError);
        // Failed write callbacks can precede their EPIPE error event. Keep our
        // one-shot listener until process exit; never attempt a second receipt.
        resolve(ok);
      };
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), Math.min(100, available));
      process.stdout.once('error', onError);
      try {
        process.stdout.write(JSON.stringify(outcome) + '\n', (error) => finish(!error));
      } catch {
        finish(false);
      }
    });
  }
  process.exit(written ? exitCode : 1);
}
setTimeout(
  () =>
    retirementPublish(
      ownedMainInspectorDeadlineOutcome() ?? {
        ok: false,
        reason: 'deadline_exhausted',
        retryAllowed: false,
      },
      1
    ),
  Math.max(1, retirementWorkDeadline - Date.now())
);
const retirementExpectedSource = 'eed06fe51dea622069c661a6213d5b031ff3a9e3';
const retirementRemaining = () => {
  const left = retirementWorkDeadline - Date.now();
  if (!Number.isSafeInteger(retirementDeadline) || left <= 0 || left > 20000)
    throw new Error('retirement_deadline');
  return left;
};
function retirementRuntime() {
  retirementRemaining();
  if (
    process.version !== 'v22.23.2' ||
    process.env.GIT_COMMIT_SHA !== retirementExpectedSource ||
    JSON.stringify(
      retirementFs.readFileSync('/proc/1/cmdline', 'utf8').split('\0').filter(Boolean)
    ) !== JSON.stringify(['node', 'dist/index.js'])
  )
    throw new Error('retirement_runtime');
}
async function retirementDiscover() {
  return new Promise((resolve, reject) => {
    let body = '',
      ended = false,
      answer;
    const request = retirementHttp.get(
      {
        host: '127.0.0.1',
        port: 9229,
        path: '/json/list',
        agent: false,
        headers: { Connection: 'close' },
        timeout: Math.min(1000, retirementRemaining()),
      },
      (response) => {
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > 16384)
            request.destroy(new Error('retirement_discovery_bound'));
        });
        response.on('end', () => {
          try {
            const targets = JSON.parse(body);
            if (
              response.statusCode !== 200 ||
              !Array.isArray(targets) ||
              targets.length !== 1 ||
              typeof targets[0].webSocketDebuggerUrl !== 'string' ||
              !/^ws:\/\/127\.0\.0\.1:9229\/[0-9a-f-]{36}$/i.test(targets[0].webSocketDebuggerUrl)
            )
              throw new Error('retirement_endpoint');
            answer = targets[0].webSocketDebuggerUrl;
            ended = true;
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('socket', (socket) =>
      socket.once('close', () => {
        if (ended) resolve(answer);
      })
    );
    request.once('timeout', () => request.destroy(new Error('retirement_discovery_timeout')));
    request.once('error', reject);
  });
}
async function retirementEntry() {
  retirementRuntime();
  const endpoint = await retirementDiscover();
  const binding = captureMainInspectorBinding({
    pid: 1,
    port: 9229,
    deadlineMs: retirementWorkDeadline,
  });
  const proposal = { schema: 'main-inspector-retirement/v1', endpoint, binding };
  const serialized = JSON.stringify(proposal);
  const digest = retirementHash('sha256').update(serialized).digest('hex');
  console.log(serialized);
  // No attach until root has fsynced this exact proposal inside its operation claim.
  const ack = await new Promise((resolve, reject) => {
    let input = '';
    const timer = setTimeout(
      () => reject(new Error('retirement_claim_timeout')),
      retirementRemaining()
    );
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
      if (input.length > 65) {
        clearTimeout(timer);
        reject(new Error('retirement_claim_bound'));
      } else if (input.endsWith('\n')) {
        clearTimeout(timer);
        resolve(input);
      }
    });
    process.stdin.once('end', () => {
      clearTimeout(timer);
      reject(new Error('retirement_claim_missing'));
    });
  });
  if (ack !== digest + '\n') throw new Error('retirement_claim_mismatch');
  const outcome = await retireOwnedMainInspector({
    endpoint,
    expectedPid: 1,
    deadlineMs: retirementWorkDeadline,
    qualify: async (stage) => {
      retirementRuntime();
      // The proposal already binds the endpoint to this exact MAIN listener.
      // Recheck its PID/start/namespace/inode and exclusive clients below.
      // Another HTTP discovery here creates our own closing client immediately
      // before that zero-client proof; do not introduce a new socket after ACK.
      captureMainInspectorBinding({
        pid: 1,
        port: 9229,
        deadlineMs: retirementWorkDeadline,
        allowOwnClient: stage === 'close',
        expectedBinding: binding,
      });
      // Reserve five seconds for remote close inside the same absolute budget.
      if (stage === 'close' && retirementRemaining() <= 5000) return false;
      return true;
    },
  });
  if (!outcome.ok) return outcome;
  retirementRuntime();
  await new Promise((resolve, reject) => {
    const request = retirementHttp.get(
      {
        host: '127.0.0.1',
        port: 9229,
        path: '/json/list',
        agent: false,
        timeout: Math.min(1000, retirementRemaining()),
      },
      (response) => {
        response.resume();
        reject(new Error('retirement_listener_retained'));
      }
    );
    request.once('timeout', () => request.destroy(new Error('retirement_absence_timeout')));
    request.once('error', (error) => (error.code === 'ECONNREFUSED' ? resolve() : reject(error)));
  });
  return { ...outcome, listenerAbsent: true };
}
retirementEntry().then(
  (outcome) => retirementPublish(outcome, outcome.ok && outcome.listenerAbsent ? 0 : 1),
  () =>
    retirementPublish(
      {
        ok: false,
        reason: 'main_inspector_retirement_unproved',
        retryAllowed: false,
      },
      1
    )
);
