"""Current accounting-job identity for the retained BBJ fixture; no CLI or effects on import."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
from datetime import datetime
import urllib.request

from deadline import CaseDeadline

REPOSITORY = 'Smarter-Poker/Smarter-Poker-Club-Arena'
WORKFLOW = REPOSITORY + '/.github/workflows/ci.yml@'
CASES = ('SEQ08_BBJ_BACKUP_POSITIVE_MAIN_TRANSFER_25',
         'SEQ08_BBJ_PROMO_POSITIVE_MAIN_TRANSFER_25')
OPENING = 'SEQ08_BBJ_MAIN_POSITIVE_OPENING_SETUP'
ACTOR = '7beef002-0002-4000-8000-000000000001'
CLUB = '7beef002-0002-4000-8000-000000000002'
# The restored hosted job supplies PG17 through its existing signed package path.
# Record this invocation's actual binary identities; never reuse retired worker pins.
PROVIDER_BINARIES = ('postgres', 'initdb', 'pg_ctl', 'psql')
ACCOUNTING_JOB_NAME = 'Accounting transactions (PostgreSQL 17)'
JOB_SECONDS = 900
# Finite first qualification ceilings, not observed funded runtimes. Setup's
# original 300-second cap and three original 30-second physical cleanup caps.
CASE_SECONDS = 300
CLEANUP_SECONDS = 90


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_exclusive(path, value):
    """An attempt/identity is never replaced, including after an unknown outcome."""
    with Path(path).open('x') as stream:
        stream.write(json.dumps(value, indent=2, default=str) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(Path(path).parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def identity(environment, event, head, parents, workspace):
    """Validate current checkout/event association without accepting old approval JSON."""
    require(environment.get('GITHUB_ACTIONS') == 'true' and environment.get('CI') == 'true',
            'Existing GitHub accounting CI invocation required')
    require(environment.get('GITHUB_REPOSITORY') == REPOSITORY and
            environment.get('GITHUB_JOB') == 'accounting_postgres', 'Wrong repository or accounting job')
    require(environment.get('GITHUB_SERVER_URL') == 'https://github.com' and
            environment.get('GITHUB_WORKFLOW_REF') == WORKFLOW + environment.get('GITHUB_REF', ''), 'Wrong workflow origin')
    require(environment.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
            environment.get('RUNNER_OS') == 'Linux' and environment.get('RUNNER_ARCH') == 'X64',
            'Original GitHub-hosted Linux X64 accounting job required')
    require(re.fullmatch('[0-9a-f]{40}', head) is not None and
            head == environment.get('GITHUB_SHA'), 'Actual checkout must match this workflow revision')
    require(Path(environment.get('GITHUB_WORKSPACE', '')).resolve() == workspace.resolve(),
            'Unexpected accounting checkout')
    for field in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'):
        require(re.fullmatch('[1-9][0-9]*', environment.get(field, '')) is not None,
                'Canonical current workflow run/attempt required')
    require(type(environment.get('RUNNER_NAME')) is str and bool(environment['RUNNER_NAME'].strip()),
            'Actual hosted runner name required for evidence')
    event_name = environment.get('GITHUB_EVENT_NAME')
    if event_name == 'pull_request':
        pr = event.get('pull_request', {})
        require(pr.get('head', {}).get('repo', {}).get('full_name') == REPOSITORY and
                pr.get('base', {}).get('repo', {}).get('full_name') == REPOSITORY and
                pr.get('base', {}).get('ref') == 'main', 'Same-repository main-target PR required')
        source = pr.get('head', {}).get('sha')
        require(re.fullmatch('[0-9a-f]{40}', str(source)) is not None and
                (source == head or source in parents), 'PR source is not in the actual checkout identity')
        require(environment.get('GITHUB_REF') == 'refs/pull/' + str(event.get('number')) + '/merge',
                'Current PR merge reference required')
    elif event_name == 'schedule':
        require(environment.get('GITHUB_REF') == 'refs/heads/main', 'Scheduled existing main verification only')
        source = head
    else:
        raise RuntimeError('No manual, external, or historical financial admission is accepted')
    return dict(repository=REPOSITORY, commit=head, source_commit=source,
                workflow_ref=environment['GITHUB_WORKFLOW_REF'], run_id=environment['GITHUB_RUN_ID'],
                run_attempt=environment['GITHUB_RUN_ATTEMPT'], job='accounting_postgres',
                runner=environment['RUNNER_NAME'], event=event_name, ref=environment['GITHUB_REF'])


# Only fixed local validation messages may become public diagnostic codes.
# Never print exception text: an HTTP/Git/JSON error can contain private inputs.
TIMING_REFUSAL_CODES = {
    'Pristine current checkout required': 'CHECKOUT_NOT_PRISTINE',
    'Existing GitHub accounting CI invocation required': 'CI_INVOCATION_MISMATCH',
    'Wrong repository or accounting job': 'REPOSITORY_OR_JOB_MISMATCH',
    'Wrong workflow origin': 'WORKFLOW_ORIGIN_MISMATCH',
    'Original GitHub-hosted Linux X64 accounting job required': 'HOSTED_RUNNER_ROUTE_MISMATCH',
    'Actual checkout must match this workflow revision': 'CHECKOUT_REVISION_MISMATCH',
    'Unexpected accounting checkout': 'CHECKOUT_PATH_MISMATCH',
    'Canonical current workflow run/attempt required': 'RUN_OR_ATTEMPT_MALFORMED',
    'Actual hosted runner name required for evidence': 'RUNNER_NAME_MISSING',
    'Same-repository main-target PR required': 'PR_REPOSITORY_OR_BASE_MISMATCH',
    'PR source is not in the actual checkout identity': 'PR_SOURCE_NOT_CHECKOUT_PARENT',
    'Current PR merge reference required': 'PR_MERGE_REFERENCE_MISMATCH',
    'Scheduled existing main verification only': 'SCHEDULE_REFERENCE_MISMATCH',
    'No manual, external, or historical financial admission is accepted': 'EVENT_NOT_ADMITTED',
    'Malformed checked-out commit parent header': 'COMMIT_PARENT_HEADER_MALFORMED',
    'Hosted temporary directory required': 'TIMING_DIRECTORY_MISSING',
    'Exact owned current-attempt timing path required': 'TIMING_PATH_MISMATCH',
    'Current timing observation cannot be replaced or reused': 'TIMING_OBSERVATION_ALREADY_EXISTS',
    'Timing step requires its scoped read-only Actions token': 'TIMING_TOKEN_MISSING',
    'Timing metadata redirect refused': 'TIMING_REDIRECT_REFUSED',
    'Timing metadata response refused': 'TIMING_HTTP_STATUS_REFUSED',
    'Timing metadata response exceeds bound': 'TIMING_RESPONSE_OVERSIZED',
    'Incomplete current-attempt job response': 'ATTEMPT_JOB_RESPONSE_INCOMPLETE',
    'Exactly one current accounting job required': 'ACCOUNTING_JOB_NOT_UNIQUE',
    'Actual job does not match this hosted checkout/run/attempt/runner': 'JOB_IDENTITY_MISMATCH',
    'Actual UTC job start required': 'JOB_START_MISSING',
    'Malformed actual job start': 'JOB_START_MALFORMED',
    'Actual accounting job start/deadline is not current': 'JOB_DEADLINE_NOT_CURRENT',
    'Insufficient actual job time for a bounded case and cleanup': 'JOB_BUDGET_INSUFFICIENT',
}


class TimingRequestRefused(RuntimeError):
    def __init__(self, reason_code):
        allowed = set(TIMING_REFUSAL_CODES.values()) | {'TIMING_TRANSPORT_OR_DECODING_REFUSED'}
        self.reason_code = reason_code if reason_code in allowed else 'LOCAL_OPERATION_REFUSED'
        super().__init__('Current job timing request refused; no retry')


def timing_refusal_reason(error):
    if type(error) is TimingRequestRefused:
        return error.reason_code
    if type(error) is RuntimeError:
        return TIMING_REFUSAL_CODES.get(str(error), 'LOCAL_OPERATION_REFUSED')
    return 'LOCAL_OPERATION_REFUSED'


def checkout_identity(git):
    """Read physical commit headers; revision walking hides shallow parents."""
    head = git('rev-parse', 'HEAD')
    headers = git('cat-file', '-p', head).split('\n\n', 1)[0]
    parents = [line[7:] for line in headers.splitlines() if line.startswith('parent ')]
    require(all(re.fullmatch('[0-9a-f]{40}', parent) is not None for parent in parents),
            'Malformed checked-out commit parent header')
    return head, parents


def timing_url(current):
    return ('https://api.github.com/repos/' + REPOSITORY + '/actions/runs/' +
            current['run_id'] + '/attempts/' + current['run_attempt'] + '/jobs?per_page=100')


def timing_observation(current, response, now):
    """Select the current attempt's one actual, running, non-matrix accounting job."""
    require(type(response) is dict and type(response.get('jobs')) is list and
            type(response.get('total_count')) is int and
            response['total_count'] == len(response['jobs']) <= 100,
            'Incomplete current-attempt job response')
    jobs = [job for job in response['jobs'] if type(job) is dict and job.get('name') == ACCOUNTING_JOB_NAME]
    require(len(jobs) == 1, 'Exactly one current accounting job required')
    job = jobs[0]
    require(type(job.get('id')) is int and job['id'] > 0 and
            str(job.get('run_id')) == current['run_id'] and
            job.get('runner_name') == current['runner'] and
            job.get('head_sha') in (current['commit'], current['source_commit']) and
            job.get('status') == 'in_progress' and job.get('conclusion') is None and
            job.get('completed_at') is None and job.get('labels') == ['ubuntu-latest'],
            'Actual job does not match this hosted checkout/run/attempt/runner')
    started = job.get('started_at')
    require(type(started) is str and started.endswith('Z'), 'Actual UTC job start required')
    try:
        start = datetime.fromisoformat(started.replace('Z', '+00:00')).timestamp()
    except (ValueError, OverflowError):
        raise RuntimeError('Malformed actual job start') from None
    require(math.isfinite(start) and 0 < start <= now < start + JOB_SECONDS,
            'Actual accounting job start/deadline is not current')
    require(now + CASE_SECONDS + CLEANUP_SECONDS <= start + JOB_SECONDS,
            'Insufficient actual job time for a bounded case and cleanup')
    fields = ('id','run_id','name','runner_name','head_sha','status','conclusion','completed_at','labels','started_at')
    selected = {key: job[key] for key in fields}
    timing = {key: current[key] for key in ('repository','commit','run_id','run_attempt','job')}
    timing.update(job_started_at_unix=start, job_deadline_unix=start + JOB_SECONDS,
                  case_execution_seconds=CASE_SECONDS, cleanup_reserve_seconds=CLEANUP_SECONDS)
    return selected, timing


def timing_path(path, current, environment):
    require(type(environment.get('RUNNER_TEMP')) is str and environment['RUNNER_TEMP'], 'Hosted temporary directory required')
    root = Path(environment['RUNNER_TEMP']).resolve()
    candidate = Path(path)
    require(candidate.is_absolute() and candidate.parent == root and not candidate.is_symlink() and
            candidate.name == 'bbj-job-timing-' + current['run_id'] + '-' + current['run_attempt'] + '.json',
            'Exact owned current-attempt timing path required')
    return candidate


def produce_job_timing(repository, output):
    """Read metadata once in the preceding token-scoped CI step; never run PG."""
    repository = Path(repository).resolve()
    def git(*arguments):
        return subprocess.check_output(['git','-C',str(repository),*arguments],text=True,timeout=30).strip()
    require(git('rev-parse','--show-toplevel') == str(repository) and
            not git('status','--porcelain','--untracked-files=no'), 'Pristine current checkout required')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    head, parents = checkout_identity(git)
    current = identity(os.environ,event,head,parents,repository)
    output = timing_path(output,current,os.environ)
    require(not output.exists(), 'Current timing observation cannot be replaced or reused')
    token = os.environ.get('GH_TOKEN')
    require(type(token) is str and bool(token), 'Timing step requires its scoped read-only Actions token')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *arguments, **keywords):
            raise RuntimeError('Timing metadata redirect refused')
    request = urllib.request.Request(timing_url(current),headers={
        'Accept':'application/vnd.github+json','Authorization':'Bearer ' + token,
        'X-GitHub-Api-Version':'2022-11-28'})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request,timeout=30) as response:
            require(response.status == 200, 'Timing metadata response refused')
            raw = response.read(2 * 1024 * 1024 + 1)
            require(len(raw) <= 2 * 1024 * 1024, 'Timing metadata response exceeds bound')
        selected, timing = timing_observation(current,json.loads(raw),time.time())
    except BaseException as error:
        # Never put HTTP headers, token, response body or server error details in logs.
        reason = timing_refusal_reason(error)
        if reason == 'LOCAL_OPERATION_REFUSED':
            reason = 'TIMING_TRANSPORT_OR_DECODING_REFUSED'
        raise TimingRequestRefused(reason) from None
    finally:
        token = None
    write_exclusive(output,{'format':1,'identity':current,'request_url':timing_url(current),
                            'response_sha256':hashlib.sha256(raw).hexdigest(),'job':selected,'timing':timing})
    return output


class CurrentAccountingRun:
    def __init__(self, repository, pg_bin, output, custody):
        self.repository = Path(repository).resolve()
        self.pg_bin = Path(pg_bin).resolve()
        self.output = Path(output).resolve()
        self.custody = custody
        self._cases = {}
        self.runtime = None
        self.child_env = {key: value for key, value in os.environ.items()
                          if not key.startswith('PG') and key not in
                          ('DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GH_TOKEN', 'GITHUB_TOKEN')}
        self.child_env.update(LC_ALL='C', TZ='UTC')
        self.assert_pristine()
        event_path = Path(os.environ.get('GITHUB_EVENT_PATH', ''))
        require(event_path.is_file(), 'Current Actions event file required')
        event = json.loads(event_path.read_text())
        head, parents = checkout_identity(self.git)
        self.identity = identity(os.environ, event, head, parents, self.repository)
        require(self.output.is_relative_to(self.repository / 'artifacts/bbj-bank-replay') and
                not self.output.is_symlink(), 'Funded receipts must use the existing retained artifact directory')
        self.output.mkdir(mode=0o700, parents=False, exist_ok=False)
        self.token = str(uuid.uuid4())
        self.attempt = {**self.identity, 'invocation_id': self.token, 'case_ids': list(CASES),
                        'manifest_sha256': custody.receipt()['manifest_sha256'],
                        'status': 'ATTEMPTED_OUTCOME_UNCERTAIN',
                        'historical_authority_reused': False, 'funded_cases_executed': []}
        write_exclusive(self.output / 'ATTEMPT.json', self.attempt)

    def git(self, *arguments):
        return subprocess.check_output(['git', '-C', str(self.repository), *arguments],
                                       text=True, timeout=30).strip()

    def assert_pristine(self):
        require(self.git('rev-parse', '--show-toplevel') == str(self.repository), 'Wrong Git source root')
        require(not self.git('status', '--porcelain', '--untracked-files=no'), 'Tracked source is dirty')
        if hasattr(self, 'identity'):
            require(self.git('rev-parse', 'HEAD') == self.identity['commit'], 'Checkout changed during fixture')
        # Reverify all exact retained inputs; no policy file or historical run is read as authority.
        self.custody.__class__()

    def read_job_timing(self, path):
        require(type(path) is str and bool(path), 'Missing preceding-step current job timing receipt')
        path = timing_path(path,self.identity,os.environ)
        packet = json.loads(path.read_text())
        require(type(packet) is dict and set(packet) == {'format','identity','request_url','response_sha256','job','timing'} and
                packet['format'] == 1 and packet['identity'] == self.identity and
                packet['request_url'] == timing_url(self.identity) and
                re.fullmatch('[0-9a-f]{64}',str(packet['response_sha256'])) is not None,
                'Current job timing receipt identity changed')
        selected,timing = timing_observation(self.identity,{'total_count':1,'jobs':[packet['job']]},time.time())
        require(selected == packet['job'] and timing == packet['timing'], 'Actual timing receipt changed')
        write_exclusive(self.output/'JOB-TIMING-SOURCE.json',packet)
        return timing

    def bind_job_timing(self, timing):
        """Consume the genuine preceding-step observation, never invocation start."""
        require(type(timing) is dict, 'Missing existing accounting-job start/deadline and reviewed case/cleanup timing input')
        expected = {'repository', 'commit', 'run_id', 'run_attempt', 'job',
                    'job_started_at_unix', 'job_deadline_unix', 'case_execution_seconds', 'cleanup_reserve_seconds'}
        require(set(timing) == expected, 'Exact existing-job timing fields required')
        for key in ('repository', 'commit', 'run_id', 'run_attempt', 'job'):
            require(timing[key] == self.identity[key], 'Timing belongs to a different current job: ' + key)
        for key in ('job_started_at_unix', 'job_deadline_unix', 'case_execution_seconds', 'cleanup_reserve_seconds'):
            require(type(timing[key]) in (int, float) and math.isfinite(timing[key]) and timing[key] > 0, 'Positive actual timing value required')
        require(timing['job_deadline_unix'] - timing['job_started_at_unix'] == 900,
                'Preserve the existing 15-minute accounting job limit')
        require(timing['job_started_at_unix'] <= time.time() < timing['job_deadline_unix'],
                'Current accounting job deadline is not usable')
        require(timing['case_execution_seconds'] + timing['cleanup_reserve_seconds'] < 900,
                'Reviewed single-case and cleanup budget does not fit the existing job')
        require(not hasattr(self, 'timing'), 'Current job timing cannot be rebound')
        self.timing = dict(timing)
        self.job_deadline_monotonic = time.monotonic() + timing['job_deadline_unix'] - time.time()
        write_exclusive(self.output/'JOB-TIMING.json', timing)
        self.require_case_time()

    def require_case_time(self):
        require(hasattr(self, 'timing'), 'Existing accounting timing producer is not bound')
        remaining = min(self.timing['job_deadline_unix'] - time.time(), self.job_deadline_monotonic - time.monotonic())
        require(remaining >= self.timing['case_execution_seconds'] + self.timing['cleanup_reserve_seconds'],
                'Insufficient current job time for an original funded case and its cleanup; no retry')

    def verify_provider_bytes(self):
        require(self.runtime is not None and self.runtime.get('runtime_verified') is True,
                'Actual current hosted runtime must be observed before any case')
        for name in PROVIDER_BINARIES:
            require(sha(self.pg_bin/name) == self.runtime['actual_binaries'][name]['sha256'],
                    'Current hosted provider changed since runtime observation: ' + name)

    def verify_runtime(self):
        self.require_case_time()
        require(self.pg_bin == Path('/usr/lib/postgresql/17/bin'),
                'Use the original hosted accounting job PostgreSQL path')
        records = {}
        report = {'required_version': '17.11', 'actual_binaries': records, 'runtime_verified': False,
                  'current_accounting_ci': self.identity, 'historical_provider_used': False}
        try:
            for name in PROVIDER_BINARIES:
                self.require_case_time()
                path = self.pg_bin / name
                require(path.is_file() and os.access(path, os.X_OK), 'Missing hosted PG17.11 binary: ' + name)
                digest = sha(path)
                returned = subprocess.run([str(path), '--version'], text=True, capture_output=True,
                                          env=self.child_env, timeout=min(15, self.job_deadline_monotonic-time.monotonic()))
                records[name] = dict(path=str(path), sha256=digest, exit=returned.returncode,
                                     stdout=returned.stdout, stderr=returned.stderr)
                require(sha(path) == digest and returned.returncode == 0 and
                        re.search(r'\(PostgreSQL\) 17\.11(?:\s|$)', returned.stdout),
                        'Unchanged actual PostgreSQL17.11 required: ' + name)
            report['runtime_verified'] = True
            self.runtime = report
            return report
        finally:
            write_exclusive(self.output / 'RUNTIME.json', report)

    def case_deadline(self, case):
        return self._cases[case]['deadline']

    def new_case(self, case):
        require(case in CASES and case not in self._cases and self.runtime is not None,
                'Only one fresh admitted lifetime per selected case')
        self.assert_pristine()
        self.verify_provider_bytes()
        self.require_case_time()
        operation = {'case': case, 'case_attempt_id': str(uuid.uuid4()),
                     'opening_operation_id': str(uuid.uuid4()),
                     'move_operation': 'bbj-ci-' + str(uuid.uuid4()),
                     'move_reason': 'Qualify the original funded BBJ ' + ('backup' if case == CASES[0] else 'promo') +
                                    ' balance with a 25-chip main-bank transfer.',
                     'current_invocation_id': self.token}
        directory = self.output / case.lower()
        directory.mkdir(mode=0o700, exist_ok=False)
        write_exclusive(directory / 'ATTEMPT.json', {**self.identity, **operation,
                        'status': 'ATTEMPTED_OUTCOME_UNCERTAIN', 'database_identity': None})
        deadline = CaseDeadline(min(self.timing['job_deadline_unix'],
                                    time.time() + self.job_deadline_monotonic-time.monotonic()),
                                self.timing['case_execution_seconds'], self.timing['cleanup_reserve_seconds'])
        self._cases[case] = {'deadline': deadline, 'authorization': dict(operation), 'directory': directory, 'physical': None,
                             'seed_claimed': False, 'opening_claimed': False, 'transfer_claimed': False}
        return operation, directory

    def bind_clone(self, case, actual, expected, validator, raw):
        state = self._cases[case]
        require(state['physical'] is None, 'Physical case identity cannot be rebound')
        validator(actual, expected)
        require(expected['database'] == case.lower(), 'Selected case clone name differs')
        require(actual.get('server_version_num') == 170011, 'Actual server minor is not PostgreSQL17.11')
        names = ('auth.users', 'public.clubs', 'public.chip_ledger', 'public.ca_account_snapshots', 'public.ca_currency_meter')
        require(set(raw.get('raw', {})) and all(raw['raw'][name] == [] for name in names),
                'Pristine unseeded physical clone is required before effects')
        write_exclusive(state['directory'] / 'CLONE.json', {'physical': actual, 'expected': expected,
                        'preseed_raw_sha256': hashlib.sha256(json.dumps(raw, sort_keys=True, default=str).encode()).hexdigest()})
        state['physical'] = dict(expected)

    def require_case(self, authorization, case=None, driver=None):
        require(type(authorization) is dict and authorization.get('case') in self._cases,
                'Current constructor-issued case identity required')
        selected = authorization['case']
        require(authorization == self._cases[selected]['authorization'] and
                (case is None or case == selected), 'Current case operation identity differs')
        self.assert_pristine()
        if driver is not None:
            require(Path(driver.__file__).resolve() == self.custody.source_path('schema/sequence_driver.py') and
                    driver.ACTOR == ACTOR and driver.CLUB == CLUB, 'Original persistent driver and seed actors required')
        return selected

    def claim_seed(self, case):
        state = self._cases[case]
        require(state['physical'] is not None and state['opening_claimed'] and not state['seed_claimed'],
                'Seed requires admitted opening in one pristine physical clone')
        state['seed_claimed'] = True  # Record before the original seed; ambiguous seed is never retried.
        write_exclusive(state['directory'] / 'SEED-ATTEMPT.json', {'case': case, 'status': 'ATTEMPTED_OUTCOME_UNCERTAIN'})

    def verify_financial_call(self, selected, phase, authorization, driver, seed, opening=None):
        state = self._cases[selected]
        current = state['authorization']
        self.require_case(current, selected, driver)
        require(state['physical'] is not None and callable(seed), 'Root-owned pristine clone/seed callback required')
        require(authorization.get('database') == state['physical']['database'] and
                authorization.get('database_oid') == state['physical']['database_oid'], 'Different physical case authorization')
        require(authorization.get('seed_sha256') == sha(self.custody.source_path('resources/seed.sql')),
                'Exact original seed0007 required')
        key = 'opening_claimed' if phase == 'opening' else 'transfer_claimed'
        require(not state[key], 'A financial case dispatch cannot be repeated')
        if phase == 'opening':
            require(authorization.get('case') == OPENING and
                    authorization.get('operation_id') == current['opening_operation_id'], 'Fresh original opening operation required')
        else:
            require(state['opening_claimed'] and state['seed_claimed'] and authorization.get('case') == selected,
                    'Selected continuation requires this actual opening setup')
            require(authorization.get('opening_operation_id') == current['opening_operation_id'] and
                    authorization.get('move_operation') == current['move_operation'] and
                    authorization.get('move_reason') == current['move_reason'], 'Fresh current transfer identity required')
            require(opening is not None and Path(opening.__file__).resolve() == self.custody.source_path('opening/case_module.py'),
                    'Original opening implementation required')
            for name in ('validate_producer', 'original_seed', 'notes', 'parse_command'):
                require(callable(getattr(opening, name, None)), 'Original opening support missing: ' + name)
        state[key] = True
        write_exclusive(state['directory'] / (phase.upper() + '-ATTEMPT.json'),
                        {**current, 'phase': phase, 'physical': state['physical'], 'status': 'ATTEMPTED_OUTCOME_UNCERTAIN'})


if __name__ == '__main__':
    import argparse
    import sys
    parser = argparse.ArgumentParser(description='Observe this existing accounting job once; no database execution')
    parser.add_argument('--write-job-timing', required=True)
    arguments = parser.parse_args()
    try:
        path = produce_job_timing(Path(__file__).resolve().parents[5],arguments.write_job_timing)
        print(json.dumps({'status':'CURRENT_JOB_TIMING_RECORDED','path':str(path)}))
    except BaseException as error:
        print(json.dumps({'status':'CURRENT_JOB_TIMING_REFUSED','error_type':type(error).__name__,
                          'reason_code':timing_refusal_reason(error),
                          'financial_execution':False,'automatic_retry':False}))
        sys.exit(1)
