"""Source composition checks only; the hosted native case owns lifecycle proof."""
import importlib.util
from pathlib import Path
import unittest

HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('ev_bootstrap',HERE/'bootstrap.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)

class Composition(unittest.TestCase):
    def test_native_auth_is_not_replaced_by_application_capture(self):
        sql=b.application_schema()
        self.assertNotIn('CREATE TABLE "auth".',sql)
        self.assertNotIn('CREATE TYPE "auth".',sql)
        self.assertNotIn('FUNCTION auth.',sql)
        self.assertNotIn('CREATE ROLE',sql)
        self.assertNotIn('CREATE TRIGGER',sql)
    def test_real_critical_authorities_and_money_triggers_are_composed(self):
        chunks=dict(b.chunks())
        self.assertIn('fn_ca_commit_hand_submission',chunks['current-critical-authorities'])
        self.assertIn('fn_ca_process_hand_post_commit_obligations',chunks['current-critical-authorities'])
        self.assertIn('insurance_balance=insurance_bank',chunks['money-and-seat-triggers'])
        self.assertIn('fn_club_members_ledger_writer()',chunks['money-and-seat-triggers'])
        self.assertNotIn("AS 'SELECT true'",'\n'.join(chunks.values()))
        for name in ['zzzz_stamp_table_game_scope','zzzz_stamp_table_seat_admission','zzzzz_table_parent_keys_guard','zzzzz_table_scope_cascade']:
            self.assertIn('CREATE TRIGGER '+name, chunks['money-and-seat-triggers'])
    def test_funding_rejoin_and_clock_dependencies_are_real(self):
        chunks=dict(b.chunks())
        self.assertIn('required_stack', chunks['public.cash_rejoin_constraints'])
        self.assertIn('cash_rejoin_constraints_required_stack_check', chunks['current-relation-constraints'])
        self.assertIn('clock_timestamp() - COALESCE(p_last_tick', chunks['current-critical-authorities'])
        native=(HERE/'native.mjs').read_text()
        self.assertIn('JOIN public.cash_participant_funding_receipts', native)
        self.assertIn('[150, 850, 150, 1000, 850]', native)
        self.assertNotIn('result.rows[0].result.success', native)
    def test_actor_uses_current_controller_contract_and_finite_progress(self):
        actor=(HERE/'actor.mjs').read_text()
        self.assertIn('state.currentBet > p.bet',actor)
        self.assertNotIn('state.current_bet',actor)
        self.assertIn('++passiveActions <= 8',actor)
        self.assertIn('await engine.stop()',actor)
        self.assertLess(actor.index('try {', actor.index('let actorFailure')), actor.index('claimProcessOwnership'))
        native=(HERE/'native.mjs').read_text()
        self.assertIn("await closeOwned('EQUITY_WORKERS_STOP_FAILED', stopEquityWorkers)",native)
        self.assertIn('process.exitCode = 1',native)
        self.assertNotIn('db.end().catch(() => {})',native)
        self.assertLess(actor.rindex('engine.stop()'),actor.rindex('http.close(resolve)'))
        runner=(HERE/'run-native.py').read_text()
        self.assertIn('except subprocess.TimeoutExpired as error:',runner)
        self.assertIn("receipt['last_stage']=record['stage']",runner)
        self.assertIn("assert result.returncode==0",runner)
    def test_fresh_engine_session_authority_is_exact_and_not_a_stub(self):
        import hashlib
        sql=dict(b.chunks())['player-session-authority']
        body=sql.split('AS $f$',1)[1].rsplit('$f$',1)[0]
        self.assertEqual(hashlib.md5(body.encode()).hexdigest(),'fc89c3f60dca4c05ba730f18c83672a1')
        self.assertIn('FROM auth.sessions WHERE id=p_session_id AND user_id=p_user_id',sql)
        self.assertIn('not_after>statement_timestamp()',sql)
        self.assertIn('FROM PUBLIC,anon,authenticated',sql)
        self.assertIn('TO service_role',sql)
        native=(HERE/'native.mjs').read_text()
        self.assertIn("'real session authority must be reachable before authenticated EV actions'",native)
        self.assertRegex(native,r'sessionLive\(users\[0\]\.id,\s*sessionIds\[1\]\),\s*false')
        self.assertRegex(native,r'sessionLive\(users\[0\]\.id,\s*null\),\s*false')
        self.assertRegex(native,r'sessionLive\(users\[1\]\.id,\s*sessionIds\[1\]\),\s*true')
        actor=(HERE/'actor.mjs').read_text()
        self.assertIn('another authenticated actor must not accept the leader quote',actor)
    def test_foreign_keys_follow_all_current_relation_keys(self):
        sql=dict(b.chunks())['current-relation-constraints']
        self.assertLess(sql.rfind('PRIMARY KEY'),sql.find('FOREIGN KEY'))

if __name__=='__main__':unittest.main()
