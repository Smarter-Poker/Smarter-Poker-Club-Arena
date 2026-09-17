"""Bound the existing funded caller's commands and owned clients; no public runner.

Every cap comes from the reviewed current-job input or an original command cap.
Timeout means uncertain outcome, never cancellation or permission to retry SQL.
"""
from contextlib import contextmanager
import math
import signal
import subprocess
import threading
import time


class DeadlineExpired(TimeoutError):
    pass


class CaseDeadline:
    def __init__(self, job_deadline_unix, execution_seconds, cleanup_seconds, clock=time):
        values = (job_deadline_unix, execution_seconds, cleanup_seconds)
        if any(type(x) not in (int, float) or not math.isfinite(x) or x <= 0 for x in values):
            raise ValueError('Finite supplied job/case/cleanup timing required')
        self.clock = clock
        now, monotonic = clock.time(), clock.monotonic()
        if job_deadline_unix - now < execution_seconds + cleanup_seconds:
            raise DeadlineExpired('Insufficient job time for supplied case and cleanup budgets')
        self.work_end = monotonic + execution_seconds
        self.end = monotonic + execution_seconds + cleanup_seconds
        self.job_end = job_deadline_unix
        self.cleanup_seconds = cleanup_seconds
        self.cleanup_used = 0.0
        self.execution_refused = False
        self.events = []
        self.processes = []

    def remaining(self, cleanup=False):
        now = self.clock.monotonic()
        shared = min(self.end - now, self.job_end - self.clock.time())
        if cleanup:
            return min(shared, self.cleanup_seconds - self.cleanup_used)
        if self.execution_refused or self.cleanup_used >= self.cleanup_seconds:
            return 0.0
        return min(shared, self.work_end - now)

    def limit(self, cap, cleanup=False):
        # Some owned operations use the remaining budget itself as their cap.
        # Depletion must retain deadline/uncertain semantics even when that cap
        # is now zero or negative; no operation can be admitted in this state.
        remaining = self.remaining(cleanup)
        if remaining <= 0:
            if not cleanup:
                self.execution_refused = True
            raise DeadlineExpired('Execution or aggregate cleanup budget depleted; outcome unqualified, no retry')
        if type(cap) not in (int, float) or not math.isfinite(cap) or cap <= 0:
            raise ValueError('Original positive command cap required')
        return min(cap, remaining)

    def checkpoint(self):
        self.limit(max(1.0, self.work_end - self.clock.monotonic()))

    @contextmanager
    def bounded(self, name, cap, cleanup=False, *, absolute_end=None):
        """Direct same-thread deadline also covers blocking pipe writes and original loops.

        POSIX setitimer is scoped to this owned call, not a watcher or background
        worker. Preserve any earlier enclosing timer without extending it.
        """
        row = {'operation': name, 'original_cap_seconds': cap, 'cleanup': cleanup,
               'status': 'ATTEMPTED_OUTCOME_UNCERTAIN'}
        self.events.append(row)
        started = self.clock.monotonic()
        armed = False
        try:
            limit = self.limit(cap, cleanup)
            if absolute_end is not None:
                row['statement_deadline_monotonic'] = absolute_end
                statement_remaining = absolute_end - started
                if statement_remaining <= 0:
                    raise DeadlineExpired(name + ': original statement deadline expired; outcome uncertain')
                limit = min(limit, statement_remaining)
            row['effective_cap_seconds'] = limit
            if threading.current_thread() is not threading.main_thread():
                raise RuntimeError('Owned funded deadline requires the main thread')
            previous = signal.getsignal(signal.SIGALRM)
            old_timer = signal.getitimer(signal.ITIMER_REAL)
            if old_timer[1]:
                raise RuntimeError('Refuse unrelated repeating alarm')
            def expired(signum, frame):
                if not cleanup:
                    self.execution_refused = True
                raise DeadlineExpired(name + ': bounded wait expired; outcome uncertain, no retry')
            signal.signal(signal.SIGALRM, expired)
            signal.setitimer(signal.ITIMER_REAL, min(limit, old_timer[0]) if old_timer[0] and not cleanup else limit)
            armed = True
            yield limit
            # A callee that caught the signal cannot turn a late result into success.
            if self.clock.monotonic() - started >= limit or self.remaining(cleanup) <= 0:
                raise DeadlineExpired(name + ': late result remains unqualified')
            row['status'] = 'RETURNED_WITHIN_BUDGET'
        except BaseException as error:
            row.update(status='FAILED_OR_UNCERTAIN', error_type=type(error).__name__, error=str(error))
            if not cleanup and isinstance(error, (TimeoutError, subprocess.TimeoutExpired, KeyboardInterrupt, SystemExit)):
                self.execution_refused = True
            raise
        finally:
            elapsed = self.clock.monotonic() - started
            if armed:
                signal.setitimer(signal.ITIMER_REAL, 0)
                signal.signal(signal.SIGALRM, previous)
                if old_timer[0] > elapsed:
                    signal.setitimer(signal.ITIMER_REAL, old_timer[0] - elapsed)
                # An enclosing expired execution timer is not rearmed inside
                # independent cleanup. Its owner checks the elapsed deadline.
            if cleanup:
                self.cleanup_used += elapsed
            row['elapsed_seconds'] = elapsed
            row['cleanup_seconds_used_total'] = self.cleanup_used

    def run(self, argv, *, env, stdin=None, timeout=180, cleanup=False):
        """Original one-shot command caps, with bounded reap after interruption.

        Avoid subprocess.run's unbounded post-kill communicate/context-manager
        wait. Retain every owned handle for the final independent cleanup pass.
        """
        process = None
        entry = {'argv': [str(x) for x in argv], 'status': 'ATTEMPTED_OUTCOME_UNCERTAIN'}
        self.processes.append(entry)
        try:
            with self.bounded('command', timeout, cleanup) as limit:
                process = subprocess.Popen(entry['argv'], stdin=subprocess.PIPE if stdin is not None else None,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
                entry.update(process=process, pid=process.pid)
                stdout, stderr = process.communicate(input=stdin, timeout=limit)
                entry.update(exit=process.returncode, stdout=stdout, stderr=stderr, status='RETURNED')
                return subprocess.CompletedProcess(entry['argv'], process.returncode, stdout, stderr)
        except BaseException as error:
            entry.update(status='FAILED_OR_UNCERTAIN', error_type=type(error).__name__, error=str(error))
            # A late context exit may follow an observed return. Keep those
            # streams/exit; a deadline error does not erase the observation.
            for field in ('stdout', 'stderr'):
                observed = getattr(error, field, None)
                if observed is not None:
                    entry[field] = observed
            # Stop only this spawned client/helper. This says nothing about a
            # server transaction's commit; never resubmit its SQL.
            self.reap(entry)
            raise

    def reap(self, entry):
        process = entry.get('process')
        outcomes = entry.setdefault('reap', [])
        if process is None:
            outcomes.append({'status': 'NO_RETURNED_PROCESS_HANDLE'})
            return
        for name, action in [('kill_if_alive', lambda: process.kill() if process.poll() is None else None),
                             ('wait', lambda: process.wait(timeout=self.limit(5, True)))]:
            result = {'action': name, 'status': 'ATTEMPTED'}
            outcomes.append(result)
            try:
                with self.bounded('helper_' + name, 5, True):
                    action()
                result.update(status='RETURNED', exit=process.poll())
            except BaseException as error:
                result.update(status='ERROR', error_type=type(error).__name__, error=str(error))
        entry['exit_after_reap'] = process.poll()

    def reap_all(self):
        for entry in self.processes:
            process = entry.get('process')
            if process is not None and process.poll() is None:
                self.reap(entry)
        return [{'argv': entry['argv'], 'pid': entry.get('pid'), 'status': entry['status'],
                 'exit': entry.get('process').poll() if entry.get('process') is not None else None,
                 'reap': entry.get('reap', [])} for entry in self.processes]

    def report(self):
        return {'execution_refused': self.execution_refused, 'cleanup_seconds_used': self.cleanup_used,
                'cleanup_seconds_allowed': self.cleanup_seconds, 'remaining_execution_seconds': self.remaining(),
                'remaining_cleanup_seconds': self.remaining(True), 'events': self.events,
                'timeout_is_cancellation': False, 'automatic_retry': False}


def install_driver_deadline(driver, budget):
    """Bound original Psql I/O without replacing its class, sql, one or close.

    The financial case requires literal original Psql type/method identity.
    Only this freshly loaded driver's subprocess/queue globals are rebound;
    other modules and modeled regressions retain their own original objects.
    """
    from types import SimpleNamespace
    original_queue = driver.queue
    original_subprocess = driver.subprocess
    # Every retained SQL call uses the unchanged driver's default timeout.
    # Source continuity verifies that contract; do not replace its method.
    statement_cap, = driver.Psql.sql.__defaults__
    if type(statement_cap) not in (int, float) or statement_cap != 60:
        raise RuntimeError('Original retained 60-second statement cap changed')
    pending = []

    class OwnedQueue:
        def __init__(self):
            self.queue = original_queue.Queue()
            self.state = {'cleanup': False, 'statement': None, 'statement_end': None}
            pending.append(self.state)

        def put(self, value):
            return self.queue.put(value)

        def get(self, timeout):
            state = self.state
            with budget.bounded('persistent_barrier', timeout, state['cleanup'],
                                absolute_end=state['statement_end']) as limit:
                result = self.queue.get(timeout=limit)
                if state['statement'] is not None:
                    state['statement']['received_lines'].append(result)
                return result

    class OwnedInput:
        def __init__(self, stream, state):
            self.stream, self.state = stream, state

        def write(self, payload):
            # Match the original driver-generated cleanup statements only;
            # business SQL cannot opt itself into the cleanup reserve.
            statement = payload.split(';\n\\echo ', 1)[0].strip().rstrip(';').upper()
            cleanup = statement in ('ROLLBACK', 'RESET ALL', 'SELECT PG_ADVISORY_UNLOCK_ALL()') or payload == 'ROLLBACK;\n\\q\n'
            self.state['cleanup'] = cleanup
            # One deadline owns this write, flush and every buffered read.
            # The original loop's .001-second floor cannot renew it.
            self.state['statement_end'] = budget.clock.monotonic() + statement_cap
            row = {'operation': 'persistent_transport', 'payload': payload,
                   'cleanup': cleanup, 'received_lines': [], 'status': 'ATTEMPTED_OUTCOME_UNCERTAIN'}
            self.state['statement'] = row
            budget.events.append(row)
            try:
                with budget.bounded('persistent_write', statement_cap, cleanup,
                                    absolute_end=self.state['statement_end']):
                    returned = self.stream.write(payload)
                row['status'] = 'WRITTEN_RESPONSE_UNCONFIRMED'
                return returned
            except BaseException as error:
                row.update(status='FAILED_OR_UNCERTAIN', error_type=type(error).__name__, error=str(error))
                raise

        def flush(self):
            cleanup = self.state['cleanup']
            with budget.bounded('persistent_flush', statement_cap, cleanup,
                                absolute_end=self.state['statement_end']):
                return self.stream.flush()

    class OwnedProcess:
        def __init__(self, process, state):
            self.process = process
            self.stdin = OwnedInput(process.stdin, state)
            self.stdout, self.stderr, self.pid = process.stdout, process.stderr, process.pid

        def poll(self):
            return self.process.poll()

        def kill(self):
            with budget.bounded('persistent_kill', budget.remaining(True), True):
                return self.process.kill()

        def wait(self, timeout):
            with budget.bounded('persistent_wait', timeout, True) as limit:
                return self.process.wait(timeout=limit)

    def popen(*args, **kwargs):
        if len(pending) != 1:
            raise RuntimeError('Original one-queue/one-process Psql constructor order changed')
        state = pending.pop()
        entry = {'argv': [str(x) for x in args[0]], 'status': 'CONSTRUCTOR_OUTCOME_UNCERTAIN'}
        budget.processes.append(entry)
        with budget.bounded('persistent_constructor', budget.remaining()):
            process = original_subprocess.Popen(*args, **kwargs)
            # Record ownership before any later wrapper/thread startup can fail.
            entry.update(process=process, pid=process.pid, status='PERSISTENT_CONSTRUCTOR_RETURNED')
            return OwnedProcess(process, state)

    driver.queue = SimpleNamespace(Queue=OwnedQueue, Empty=original_queue.Empty)
    driver.subprocess = SimpleNamespace(Popen=popen, PIPE=original_subprocess.PIPE)
    return driver.Psql
