"""Internal funded continuation for scripts/ci/test-bbj-bank-replay.py; no CLI."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest

from custody import FundedSourceCustody
from current_ci import CASES, CurrentAccountingRun, require, write_exclusive
from retained import RetainedModules
from execution import execute_retained_case
from checks import run_retained_regressions

HERE = Path(__file__).resolve().parent
IDENTITY_TESTS = {
    'test_real_checkout_and_current_pr_identity_are_both_recorded',
    'test_wrong_route_and_missing_current_identity_are_refused',
    'test_fork_and_unrelated_parent_cannot_authorize_checkout',
    'test_existing_scheduled_main_path_remains_exact',
    'test_exclusive_attempt_preserves_uncertain_original',
    'test_case_identity_is_fresh_and_cannot_be_reused_or_mutated',
    'test_seed_is_claimed_before_callback_and_never_repeated',
    'test_seed_without_physical_clone_or_opening_is_refused',
    'test_runtime_mismatch_refuses_before_binary_execution',
    'test_historical_review_cannot_supply_current_case',
    'test_missing_or_wrong_job_deadline_refuses_before_case',
    'test_original_caps_and_remaining_case_time_are_both_enforced',
    'test_cleanup_budget_is_aggregate_and_independent_refusals_remain_visible',
    'test_late_persistent_result_is_uncertain_and_cannot_continue',
    'test_original_expected_negative_error_does_not_become_deadline_failure',
    'test_interruption_closes_execution_but_preserves_independent_cleanup',
    'test_command_timeout_retains_partial_output_and_never_redispatches',
    'test_backward_wall_clock_cannot_extend_case_deadline',
    'test_cleanup_does_not_rearm_an_expired_enclosing_execution_timer',
    'test_buffered_rows_cannot_renew_original_statement_deadline',
    'test_late_command_preserves_observed_streams_and_exit_without_retry',
    'test_final_teardown_interrupts_cannot_skip_later_owned_stages',
    'test_actual_job_start_supplies_finite_caps_without_invocation_time',
    'test_timing_refuses_ambiguous_or_wrong_current_job',
    'test_shallow_pr_checkout_retains_authoritative_parent_identity',
    'test_timing_producer_is_single_read_exclusive_and_receipt_is_bound',
    'test_timing_api_failure_is_redacted_without_retry',
}


def identity_regressions(output):
    stage = {'passed': False, 'expected_tests': len(IDENTITY_TESTS), 'executed_tests': 0}
    spec = importlib.util.spec_from_file_location('current_bbj_identity_tests', HERE/'test_current_ci.py')
    tests = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tests)
    loader = unittest.TestLoader()
    names = loader.getTestCaseNames(tests.CurrentAccountingIdentityTests)
    suite = loader.loadTestsFromTestCase(tests.CurrentAccountingIdentityTests)
    require(not loader.errors and set(names) == IDENTITY_TESTS and
            len(names) == suite.countTestCases() == len(IDENTITY_TESTS), 'Exact current-route regressions required')
    observed = []
    def result_factory(*arguments, **keywords):
        result = unittest.TextTestResult(*arguments, **keywords)
        observed.append(result)
        return result
    try:
        with (output/'CURRENT-IDENTITY-CHECKS.log').open('x') as log:
            try:
                result = unittest.TextTestRunner(stream=log, verbosity=2, resultclass=result_factory).run(suite)
            finally:
                if observed:
                    result = observed[0]
                    stage.update(executed_tests=result.testsRun, test_names=names,
                                 failures=[{'test':t.id(),'detail':detail} for t,detail in result.failures],
                                 errors=[{'test':t.id(),'detail':detail} for t,detail in result.errors],
                                 skipped=[{'test':t.id(),'reason':reason} for t,reason in result.skipped],
                                 expected_failures=[{'test':t.id(),'detail':detail} for t,detail in result.expectedFailures],
                                 unexpected_successes=[test.id() for test in result.unexpectedSuccesses],
                                 successful=result.wasSuccessful())
                log.flush()
                os.fsync(log.fileno())
        require(result.testsRun == len(IDENTITY_TESTS) and result.wasSuccessful() and
                all(not stage[key] for key in ('failures','errors','skipped','expected_failures','unexpected_successes')),
                'All current-route tests must run and pass without skipped/expected failures')
        stage['passed'] = True
        return stage
    finally:
        write_exclusive(output/'CURRENT-IDENTITY-CHECKS.json', stage)


def execute_funded_cases(repository, pg_bin, output, temp_parent):
    """Fresh current CI identity; two independent original cluster/case lifetimes."""
    report = {'status': 'ATTEMPTED_OUTCOME_UNCERTAIN', 'runtime_verified': False,
              'funded_cases_attempted': [], 'funded_cases_qualified': [],
              'financial_execution_authorized': False, 'financial_qualification': False,
              'whole_original_cases_qualified': [], 'foundation_qualified': False,
              'production_authorized': False, 'cases': []}
    operation = None
    try:
        custody = FundedSourceCustody()
        operation = CurrentAccountingRun(repository, pg_bin, output, custody)
        report['current_accounting_ci'] = operation.identity
        report['identity_checks'] = identity_regressions(operation.output)
        operation.bind_job_timing(operation.read_job_timing(os.environ.get('BBJ_JOB_TIMING_FILE')))
        report['runtime'] = operation.verify_runtime()
        report['runtime_verified'] = True
        report['financial_execution_authorized'] = True  # Current isolated job only; no historical approval is changed.
        regression_receipt = None
        def regressions(binding, events, evidence):
            nonlocal regression_receipt
            if regression_receipt is None:
                result = run_retained_regressions(custody, binding.selected, events, evidence)
                path = evidence/'RETAINED-REGRESSIONS.json'
                regression_receipt = {'passed': result['passed'], 'evidence': str(path.relative_to(Path(output))),
                                      'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                      'current_invocation_id': operation.token, 'modeled_only': True}
                return {**regression_receipt, 'executed_in_this_case': True}
            operation.assert_pristine()
            path = Path(output)/regression_receipt['evidence']
            require(hashlib.sha256(path.read_bytes()).hexdigest() == regression_receipt['sha256'],
                    'Same-invocation regression receipt changed')
            return {**regression_receipt, 'executed_in_this_case': False,
                    'reuse': 'unchanged source and retained checks from this exact current invocation'}
        for case in CASES:
            authorization, evidence = operation.new_case(case)
            budget = operation.case_deadline(case)
            with budget.bounded('retained_modules',budget.remaining()):
                bound = RetainedModules(custody, operation, case)
            report['funded_cases_attempted'].append(case)
            result = execute_retained_case(bound, authorization, evidence, pg_bin, temp_parent,
                lambda binding, events: regressions(binding, events, evidence))
            run_path = evidence/'RUN.json'
            require(run_path.is_file(), 'Original funded result evidence missing')
            run = json.loads(run_path.read_text())
            summary = {'case': case, 'exit': result, 'status': run.get('status'),
                       'evidence': str(run_path.relative_to(Path(output))),
                       'sha256': hashlib.sha256(run_path.read_bytes()).hexdigest(),
                       'case_attempt_id': authorization['case_attempt_id'], 'cleanup': run.get('cleanup'),
                       'deadline': budget.report()}
            report['cases'].append(summary)
            require(result == 0 and run.get('status') == 'PASS_IMPLEMENTED_SUBSETS_ONLY' and
                    len(run.get('cases', [])) == 1 and run['cases'][0]['case'] == case and
                    run['cases'][0]['status'] == 'PASS_IMPLEMENTED_SUBSET' and
                    run.get('regressions', {}).get('passed') is True and
                    run.get('base_postflight', {}).get('status') == 'PASSED' and
                    run.get('cleanup', {}).get('inactive_proven') is True and
                    run['cleanup'].get('owned_directory_removed') is True,
                    'Original selected case, regressions, base postflight and cleanup must all pass')
            case_path = evidence/run['cases'][0]['evidence_file']
            require(hashlib.sha256(case_path.read_bytes()).hexdigest() == run['cases'][0]['sha256'],
                    'Final case receipt changed')
            report['funded_cases_qualified'].append(case)
        require(report['funded_cases_qualified'] == list(CASES), 'Both fresh selected financial cases required')
        report.update(status='PASS_FUNDED_SELECTED_CASES_ONLY', financial_qualification=True)
        return report
    except BaseException as error:
        report.update(status='FAILED_OR_UNCERTAIN', error_type=type(error).__name__, error=str(error),
                      financial_qualification=False, automatic_retry=False)
        error.funded_report = report
        raise
    finally:
        # If constructor admission fails before output creation, the outer existing
        # runner records that exception. Never fabricate a current operation receipt.
        if operation is not None:
            write_exclusive(operation.output/'RESULTS.json', report)
