/** Synthetic PostgREST projection of the 142256 weekly statement factory; no payer. */
export const WEEKLY_ID = {
  actor: 'ab000000-0000-4000-8000-000000000001',
  otherActor: 'ab000000-0000-4000-8000-000000000002',
  club: 'ab000000-0000-4000-8000-000000000003',
  otherClub: 'ab000000-0000-4000-8000-000000000004',
  invoice: 'ab000000-0000-4000-8000-000000000005',
  period: 'ab000000-0000-4000-8000-000000000006',
};
export function weeklyStatementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: WEEKLY_ID.invoice, club_id: WEEKLY_ID.club, period_id: WEEKLY_ID.period,
    invoice_type: 'club_weekly_accounting', from_entity_type: 'club', from_entity_id: WEEKLY_ID.club,
    to_entity_type: 'club', to_entity_id: WEEKLY_ID.club, gross_amount: '100.25', deductions: '60.20', net_amount: '40.05',
    status: 'generated', message_sent: true, created_at: '2026-09-14T08:00:00.000001+00:00',
    accounting_version: '3', summary_club_id: WEEKLY_ID.club, summary_period_id: WEEKLY_ID.period,
    currency: 'CHIPS', ready_to_issue: 'true', summary_status: 'complete',
    period_start: '2026-09-07T07:00:00+00:00', period_end: '2026-09-14T07:00:00+00:00',
    total_rake_funding: '100.25', total_paid_by_club: '60.20', retained_by_club: '40.05', ...overrides };
}
