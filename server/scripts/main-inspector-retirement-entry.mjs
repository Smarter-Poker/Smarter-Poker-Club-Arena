// Concatenated with maintained transport and kernel qualification by immutable control.
import * as retirementFs from 'node:fs';
import * as retirementHttp from 'node:http';
import { createHash as retirementHash } from 'node:crypto';
const retirementDeadline = Number(process.argv[1]);
setTimeout(
  () => {
    // The fixed hard exit can precede the transport timer. Preserve its bounded
    // command/ACK facts without turning a missing remote close into success.
    console.log(
      JSON.stringify(
        ownedMainInspectorDeadlineOutcome() ?? {
          ok: false,
          reason: 'deadline_exhausted',
          retryAllowed: false,
        }
      )
    );
    process.exit(1);
  },
  Math.max(1, retirementDeadline - Date.now())
);
const retirementExpectedSource = 'eed06fe51dea622069c661a6213d5b031ff3a9e3';
const retirementRemaining = () => {
  const left = retirementDeadline - Date.now();
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
    deadlineMs: retirementDeadline,
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
    deadlineMs: retirementDeadline,
    qualify: async (stage) => {
      retirementRuntime();
      // HTTP discovery during attachment would introduce a second client.
      if (stage === 'attach' && (await retirementDiscover()) !== endpoint) return false;
      captureMainInspectorBinding({
        pid: 1,
        port: 9229,
        deadlineMs: retirementDeadline,
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
  (outcome) => {
    console.log(JSON.stringify(outcome));
    process.exit(outcome.ok && outcome.listenerAbsent ? 0 : 1);
  },
  () => {
    console.log(
      JSON.stringify({
        ok: false,
        reason: 'main_inspector_retirement_unproved',
        retryAllowed: false,
      })
    );
    process.exit(1);
  }
);
