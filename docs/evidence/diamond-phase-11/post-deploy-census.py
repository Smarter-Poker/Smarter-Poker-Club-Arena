#!/usr/bin/env python3
"""Census of Post-Deploy E2E (production) failures - Phase 11 line 4 evidence.

Reads GitHub only (gh api, read scope). It never touches production, a database
or an account. For the newest completed runs of post-deploy-e2e.yml it lists
every failed step and every failing Playwright test with its first error line,
then totals them. Re-run from the repository root:

    python3 docs/evidence/diamond-phase-11/post-deploy-census.py --runs 80
    python3 docs/evidence/diamond-phase-11/post-deploy-census.py --created 2026-09-17..2026-09-18

Job logs are cached under --cache (default: a temporary directory).
"""
import argparse
import collections
import json
import os
import re
import subprocess
import tempfile

REPO = 'Smarter-Poker/Smarter-Poker-Club-Arena'
WORKFLOW = 'post-deploy-e2e.yml'
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
FAILED_TEST = re.compile(r'^\s+\d+\) \[([^\]]+)\] › (\S+?):\d+:\d+ › (.*)$')


def gh(*args):
    return subprocess.run(['gh', *args], check=True, capture_output=True, text=True).stdout


def runs(limit, created):
    path = f'repos/{REPO}/actions/workflows/{WORKFLOW}/runs?status=completed&per_page=100'
    if created:
        path += f'&created={created}'
    out = []
    for page in range(1, 20):
        data = json.loads(gh('api', f'{path}&page={page}'))
        batch = [r for r in data['workflow_runs'] if r['conclusion'] in ('success', 'failure')]
        out.extend(batch)
        if len(out) >= limit or not data['workflow_runs']:
            break
    return out[:limit]


def failed_tests(log_text):
    lines = [ANSI.sub('', line)[29:] for line in log_text.splitlines()]
    found = []
    for i, line in enumerate(lines):
        match = FAILED_TEST.match(line)
        if not match:
            continue
        error = next((l.strip()[:160] for l in lines[i + 1 : i + 40] if 'Error' in l), '')
        found.append((match.group(2), match.group(3).strip()[:110], error))
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runs', type=int, default=80)
    parser.add_argument('--created', default='')
    parser.add_argument('--cache', default=os.path.join(tempfile.gettempdir(), 'post-deploy-census'))
    args = parser.parse_args()
    os.makedirs(args.cache, exist_ok=True)

    steps = collections.Counter()
    tests = collections.defaultdict(set)
    errors = collections.defaultdict(collections.Counter)
    total = green = 0
    for run in runs(args.runs, args.created):
        total += 1
        green += run['conclusion'] == 'success'
        jobs = json.loads(gh('api', f"repos/{REPO}/actions/runs/{run['id']}/jobs?per_page=60"))['jobs']
        seen = []
        for job in jobs:
            if job['conclusion'] != 'failure':
                continue
            for step in job['steps']:
                if step['conclusion'] == 'failure':
                    steps[(job['name'], step['name'])] += 1
            cached = os.path.join(args.cache, f"{job['id']}.log")
            if not os.path.exists(cached):
                with open(cached, 'w') as handle:
                    handle.write(gh('api', f"repos/{REPO}/actions/jobs/{job['id']}/logs"))
            for spec, title, error in failed_tests(open(cached, errors='replace').read()):
                tests[(spec, title)].add(run['id'])
                errors[(spec, title)][error] += 1
                seen.append(spec.split('/')[-1])
        print(run['created_at'], run['id'], run['conclusion'], run['head_sha'][:10], ','.join(sorted(set(seen))))

    print(f'\n{total} completed runs, {green} green\n\nfailed steps (job | step): runs')
    for (job, step), count in steps.most_common():
        print(f'{count:4d}  {job} | {step}')
    print('\nfailing tests: runs, then the commonest first error lines')
    for key, run_ids in sorted(tests.items(), key=lambda item: -len(item[1])):
        print(f'{len(run_ids):4d}  {key[0]} :: {key[1]}')
        for error, count in errors[key].most_common(3):
            print(f'        [{count}] {error}')


if __name__ == '__main__':
    main()
