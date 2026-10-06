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
    def test_foreign_keys_follow_all_current_relation_keys(self):
        sql=dict(b.chunks())['current-relation-constraints']
        self.assertLess(sql.rfind('PRIMARY KEY'),sql.find('FOREIGN KEY'))

if __name__=='__main__':unittest.main()
