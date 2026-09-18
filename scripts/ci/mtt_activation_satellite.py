"""Compose the exact satellite seat-club producers into the existing activation proof.

This extends the owned isolated PG17 path; it never connects to production.
Historical captures and predecessor migrations remain immutable evidence.
"""
PRODUCERS = 'supabase/migrations/20260918021924_satellite_seat_fee_uses_exact_registration_club.sql'
SUCCESSOR = 'supabase/migrations/20260918023535_mtt_activation_preserves_satellite_entry_club.sql'
ACTIVATION = 'supabase/migrations/20260918023630_mtt_activate_unlimited_with_satellite_entry_club.sql'
NAMES = {
    'fn_ca_settle_satellite_cohort(uuid,uuid[])',
    'fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)',
}


def install_satellite(e, template, refusal, snapshot, previous_activation):
    """Replace only qualified producers and guard; prove unchanged business state."""
    for label, migration, allowed in (
        ('satellite-entry-club-producers', PRODUCERS, NAMES),
        ('satellite-entry-club-guard', SUCCESSOR, {'fn_ca_guard_mtt_admission_contract()'}),
    ):
        before_data = e.snapshot(template, label + '-before-data')
        before_catalog = snapshot(e, template, label + '-before-catalog')
        e.sql(template, file=e.root / migration, label=label)
        after_data = e.snapshot(template, label + '-after-data')
        after_catalog = snapshot(e, template, label + '-after-catalog')
        before_functions = before_catalog.pop('functions')
        after_functions = after_catalog.pop('functions')
        if (before_data != after_data or before_catalog != after_catalog
                or [r for r in before_functions if r[1] not in allowed]
                   != [r for r in after_functions if r[1] not in allowed]
                or {r[1] for r in before_functions if r[1] in allowed} != allowed
                or {r[1] for r in after_functions if r[1] in allowed} != allowed
                or any(next(r for r in before_functions if r[1] == name)
                       == next(r for r in after_functions if r[1] == name) for name in allowed)):
            raise RuntimeError('satellite activation preparation scope drift: ' + label)
        if migration == PRODUCERS:
            refusal(e, template, 'funding-guard-refuses-satellite-producers', None,
                    (e.root / previous_activation).read_text(),
                    'MTT_ACTIVATION_AUTHORITY_DRIFT: public.fn_ca_settle_satellite_cohort(uuid,uuid[])')
        e.report.setdefault('native', []).append({
            'case': label, 'business_rows_unchanged': True,
            'only_expected_function_definitions_changed': sorted(allowed),
        })
    for name in sorted(NAMES):
        refusal(e, template, 'satellite-producer-drift-' + name.split('(')[0],
                "ALTER FUNCTION public." + name + " SET statement_timeout='1s';",
                (e.root / ACTIVATION).read_text(),
                'MTT_ACTIVATION_AUTHORITY_DRIFT: public.' + name)
    refusal(e, template, 'satellite-preparation-replay-refused', None,
            (e.root / SUCCESSOR).read_text(), 'MTT_ACTIVATION_PREPARATION_PREIMAGE_DRIFT')
