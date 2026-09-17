-- Disposable Diamond bank payout fixture only; never a production migration.
-- Exact read-only catalog source and scope: schema-provenance.json.


SET search_path=public,extensions;

ALTER TABLE public."accounting_conversations" ADD CONSTRAINT "accounting_conversations_pkey" PRIMARY KEY (scope_id, issuer_type, issuer_id, sender_id, recipient_id);

ALTER TABLE public."accounting_invoice_counters" ADD CONSTRAINT "accounting_invoice_counters_next_number_check" CHECK (next_number > 0);

ALTER TABLE public."accounting_invoice_counters" ADD CONSTRAINT "accounting_invoice_counters_pkey" PRIMARY KEY (year);

ALTER TABLE public."accounting_invoice_deliveries" ADD CONSTRAINT "accounting_invoice_deliveries_delivery_mode_check" CHECK (delivery_mode = ANY (ARRAY['immediate'::text, 'weekly_detail'::text]));

ALTER TABLE public."accounting_invoice_deliveries" ADD CONSTRAINT "accounting_invoice_deliveries_message_id_key" UNIQUE (message_id);

ALTER TABLE public."accounting_invoice_deliveries" ADD CONSTRAINT "accounting_invoice_deliveries_notification_id_key" UNIQUE (notification_id);

ALTER TABLE public."accounting_invoice_deliveries" ADD CONSTRAINT "accounting_invoice_deliveries_pkey" PRIMARY KEY (invoice_id, recipient_id);

ALTER TABLE public."agents" ADD CONSTRAINT "agents_agent_wallet_balance_nonneg" CHECK (agent_wallet_balance >= 0::numeric);

ALTER TABLE public."agents" ADD CONSTRAINT "agents_club_id_user_id_key" UNIQUE (club_id, user_id);

ALTER TABLE public."agents" ADD CONSTRAINT "agents_commission_rate_check" CHECK (commission_rate >= 0::numeric AND commission_rate <= 0.70);

ALTER TABLE public."agents" ADD CONSTRAINT "agents_credit_used_check" CHECK (credit_used >= 0::numeric);

ALTER TABLE public."agents" ADD CONSTRAINT "agents_pkey" PRIMARY KEY (id);

ALTER TABLE public."agents" ADD CONSTRAINT "agents_player_rakeback_rate_check" CHECK (player_rakeback_rate >= 0::numeric AND player_rakeback_rate <= 0.50);

ALTER TABLE public."agents" ADD CONSTRAINT "agents_promo_wallet_balance_nonneg" CHECK (promo_wallet_balance >= 0::numeric);

ALTER TABLE public."agents" ADD CONSTRAINT "agents_role_check" CHECK (role = ANY (ARRAY['super_agent'::text, 'agent'::text, 'sub_agent'::text]));

ALTER TABLE public."agents" ADD CONSTRAINT "agents_status_check" CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text, 'frozen'::text]));

ALTER TABLE public."agents" ADD CONSTRAINT "check_credit" CHECK (credit_used <= credit_limit OR is_prepaid = true);

ALTER TABLE public."agents" ADD CONSTRAINT "chk_player_wallet_balance_is_two_decimal_places" CHECK (player_wallet_balance IS NULL OR player_wallet_balance = round(player_wallet_balance, 2));

CREATE INDEX idx_agents_club ON public.agents USING btree (club_id);

CREATE INDEX idx_agents_parent ON public.agents USING btree (parent_agent_id);

CREATE INDEX idx_agents_user ON public.agents USING btree (user_id);

ALTER TABLE public."credit_invoices" ADD CONSTRAINT "credit_invoices_amount_paid_check" CHECK (amount_paid >= 0::numeric);

ALTER TABLE public."credit_invoices" ADD CONSTRAINT "credit_invoices_amount_remaining_check" CHECK (amount_remaining >= 0::numeric);

ALTER TABLE public."credit_invoices" ADD CONSTRAINT "credit_invoices_debt_owed_check" CHECK (debt_owed >= 0::numeric);

ALTER TABLE public."credit_invoices" ADD CONSTRAINT "credit_invoices_pkey" PRIMARY KEY (id);

ALTER TABLE public."credit_invoices" ADD CONSTRAINT "credit_invoices_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'partial'::text, 'paid'::text, 'overdue'::text, 'disputed'::text, 'void'::text]));

CREATE UNIQUE INDEX credit_invoices_agent_period_uidx ON public.credit_invoices USING btree (agent_id, period_end);

CREATE INDEX idx_credit_invoices_agent ON public.credit_invoices USING btree (agent_id);

CREATE INDEX idx_credit_invoices_duedate ON public.credit_invoices USING btree (due_date);

ALTER TABLE public."credit_payments" ADD CONSTRAINT "credit_payments_amount_check" CHECK (amount > 0::numeric);

ALTER TABLE public."credit_payments" ADD CONSTRAINT "credit_payments_operation_id_key" UNIQUE (operation_id);

ALTER TABLE public."credit_payments" ADD CONSTRAINT "credit_payments_payment_method_check" CHECK (payment_method = ANY (ARRAY['wallet'::text, 'diamonds'::text, 'external'::text]));

ALTER TABLE public."credit_payments" ADD CONSTRAINT "credit_payments_pkey" PRIMARY KEY (id);

CREATE UNIQUE INDEX credit_payments_external_reference ON public.credit_payments USING btree (invoice_id, payment_reference) WHERE ((payment_method = 'external'::text) AND (payment_reference IS NOT NULL));

ALTER TABLE public."notifications" ADD CONSTRAINT "notifications_pkey" PRIMARY KEY (id);

CREATE UNIQUE INDEX idx_notif_dedup_friend_request ON public.notifications USING btree (user_id, type, ((data ->> 'sender_id'::text))) WHERE (type = 'friend_request'::text);

CREATE UNIQUE INDEX idx_notif_dedup_group_friend ON public.notifications USING btree (user_id, type, ((data ->> 'group_id'::text)), ((data ->> 'friend_id'::text))) WHERE (type = 'home_group_friend_joined'::text);

CREATE INDEX idx_notifications_actor_id ON public.notifications USING btree (actor_id);

CREATE INDEX idx_notifications_user_all ON public.notifications USING btree (user_id, created_at DESC);

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);

CREATE INDEX idx_notifications_user_id_id ON public.notifications USING btree (user_id, id);

CREATE INDEX idx_notifications_user_type_read ON public.notifications USING btree (user_id, type, read, created_at DESC);

CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id, read, created_at DESC) WHERE (read = false);

CREATE UNIQUE INDEX notifications_daily_mission_cycle_unique ON public.notifications USING btree (user_id, ((data ->> 'cycle_date'::text))) WHERE ((type = 'daily_challenge'::text) AND ((data ->> 'source'::text) = 'club_arena_daily_missions'::text));

CREATE UNIQUE INDEX notifications_pa_leak_audit_job_unique ON public.notifications USING btree (((data ->> 'paAuditJobId'::text))) WHERE ((type = 'personal_assistant_audit_complete'::text) AND (data ? 'paAuditJobId'::text));

ALTER TABLE public."push_outbox" ADD CONSTRAINT "accounting_push_deferral_requires_typed_receipt" CHECK (next_attempt_at IS NULL OR accounting_notification_id IS NOT NULL AND isfinite(next_attempt_at));

ALTER TABLE public."push_outbox" ADD CONSTRAINT "accounting_push_notification_identity" CHECK (accounting_notification_id IS NULL OR NOT event IS DISTINCT FROM 'accounting_invoice'::text AND NOT related_entity_id IS DISTINCT FROM accounting_notification_id);

ALTER TABLE public."push_outbox" ADD CONSTRAINT "push_outbox_pkey" PRIMARY KEY (id);

ALTER TABLE public."push_outbox" ADD CONSTRAINT "push_outbox_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'failed'::text, 'skipped'::text]));

CREATE INDEX accounting_push_deferred_due ON public.push_outbox USING btree (next_attempt_at, id) WHERE ((status = 'pending'::text) AND (next_attempt_at IS NOT NULL));

CREATE UNIQUE INDEX accounting_push_one_notification_receipt ON public.push_outbox USING btree (accounting_notification_id) WHERE (accounting_notification_id IS NOT NULL);

CREATE INDEX push_outbox_event_idx ON public.push_outbox USING btree (event, created_at DESC);

CREATE INDEX push_outbox_pending_idx ON public.push_outbox USING btree (status, created_at) WHERE (status = 'pending'::text);

CREATE INDEX push_outbox_processing_claimed_idx ON public.push_outbox USING btree (claimed_at) WHERE (status = 'processing'::text);

CREATE INDEX push_outbox_recipient_idx ON public.push_outbox USING btree (recipient_user_id, created_at DESC);

CREATE INDEX push_outbox_recipient_pending_idx ON public.push_outbox USING btree (recipient_user_id) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));

CREATE INDEX push_outbox_recipient_sent_idx ON public.push_outbox USING btree (recipient_user_id, sent_at DESC) WHERE (status = 'sent'::text);

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "accounting_invoice_has_one_source" CHECK (num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) <= 1 AND (period_id IS NOT NULL OR num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) = 1));

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "ck_whole_cents" CHECK (created_at < '2026-09-07 22:00:00+00'::timestamp with time zone OR net_amount = round(net_amount, 2) AND gross_amount = round(gross_amount, 2)) NOT VALID;

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_from_entity_type_check" CHECK (from_entity_type = ANY (ARRAY['union'::text, 'club'::text, 'agent'::text, 'player'::text]));

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_invoice_type_check" CHECK (invoice_type = ANY (ARRAY['union_to_club'::text, 'club_to_agent'::text, 'agent_to_subagent'::text, 'agent_to_player'::text, 'union_club_pnl'::text, 'club_to_union'::text, 'union_weekly_squareup'::text, 'union_weekly_credit_note'::text, 'transaction_receipt'::text, 'club_weekly_accounting'::text]));

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_pkey" PRIMARY KEY (id);

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_source_credit_invoice_id_key" UNIQUE (source_credit_invoice_id);

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_source_credit_payment_id_key" UNIQUE (source_credit_payment_id);

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_source_ledger_id_key" UNIQUE (source_ledger_id);

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'generated'::text, 'paid'::text, 'cancelled'::text, 'overdue'::text, 'disputed'::text]));

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_to_entity_type_check" CHECK (to_entity_type = ANY (ARRAY['club'::text, 'agent'::text, 'player'::text, 'union'::text]));

CREATE UNIQUE INDEX accounting_one_club_weekly_statement ON public.settlement_invoices USING btree (club_id, period_id) WHERE (invoice_type = 'club_weekly_accounting'::text);

CREATE INDEX idx_invoices_club_period ON public.settlement_invoices USING btree (club_id, period_id);

CREATE INDEX idx_invoices_type ON public.settlement_invoices USING btree (invoice_type, status);

CREATE INDEX settlement_invoices_adjusts_idx ON public.settlement_invoices USING btree (adjusts_invoice_id) WHERE (adjusts_invoice_id IS NOT NULL);

CREATE INDEX settlement_invoices_due_open_idx ON public.settlement_invoices USING btree (due_at) WHERE ((invoice_type = 'union_weekly_squareup'::text) AND (status = ANY (ARRAY['generated'::text, 'overdue'::text])));

CREATE UNIQUE INDEX settlement_invoices_number_uidx ON public.settlement_invoices USING btree (invoice_number) WHERE (invoice_number IS NOT NULL);

CREATE UNIQUE INDEX uq_settlement_invoices_squareup ON public.settlement_invoices USING btree (club_id, period_id, invoice_type) WHERE (invoice_type = 'union_weekly_squareup'::text);

ALTER TABLE public."settlement_periods" ADD CONSTRAINT "settlement_periods_pkey" PRIMARY KEY (id);

ALTER TABLE public."settlement_periods" ADD CONSTRAINT "settlement_periods_status_check" CHECK (status = ANY (ARRAY['open'::text, 'processing'::text, 'settled'::text, 'disputed'::text, 'closed'::text]));

CREATE INDEX idx_settlement_periods_club ON public.settlement_periods USING btree (club_id);

CREATE UNIQUE INDEX settlement_periods_club_union_window_uidx ON public.settlement_periods USING btree (club_id, union_id, start_at, end_at);

CREATE UNIQUE INDEX settlement_periods_one_open_per_club_uidx ON public.settlement_periods USING btree (COALESCE(club_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (status = 'open'::text);

ALTER TABLE public."social_conversation_participants" ADD CONSTRAINT "social_conversation_participants_conversation_id_user_id_key" UNIQUE (conversation_id, user_id);

ALTER TABLE public."social_conversation_participants" ADD CONSTRAINT "social_conversation_participants_pkey" PRIMARY KEY (id);

CREATE INDEX idx_scp_user_context ON public.social_conversation_participants USING btree (user_id, context_entity_id);

ALTER TABLE public."social_conversations" ADD CONSTRAINT "social_conversations_pkey" PRIMARY KEY (id);

CREATE INDEX idx_social_conversations_is_request ON public.social_conversations USING btree (is_request) WHERE (is_request = true);

ALTER TABLE public."social_messages" ADD CONSTRAINT "social_messages_pkey" PRIMARY KEY (id);

CREATE INDEX idx_messages_conversation ON public.social_messages USING btree (conversation_id, created_at DESC);

CREATE INDEX idx_social_messages_has_metadata ON public.social_messages USING btree (conversation_id, created_at) WHERE (media_metadata IS NOT NULL);

CREATE INDEX idx_social_messages_sender_id ON public.social_messages USING btree (sender_id);

ALTER TABLE public."social_pages" ADD CONSTRAINT "ck_home_group_link_is_home_game" CHECK (linked_entity_type IS DISTINCT FROM 'home_group'::text OR page_type = 'home_game'::text);

ALTER TABLE public."social_pages" ADD CONSTRAINT "social_pages_page_type_check" CHECK (page_type = ANY (ARRAY['venue'::text, 'group'::text, 'brand'::text, 'community'::text, 'club'::text, 'home_game'::text, 'charity'::text]));

ALTER TABLE public."social_pages" ADD CONSTRAINT "social_pages_pkey" PRIMARY KEY (id);

ALTER TABLE public."social_pages" ADD CONSTRAINT "social_pages_slug_key" UNIQUE (slug);

CREATE INDEX idx_social_pages_home_games ON public.social_pages USING btree (page_type, is_public, location_state, location_city) WHERE (page_type = 'home_game'::text);

CREATE INDEX idx_social_pages_linked_entity ON public.social_pages USING btree (linked_entity_type, linked_entity_id) WHERE (linked_entity_type IS NOT NULL);

CREATE INDEX idx_social_pages_linked_home_group ON public.social_pages USING btree (linked_entity_id) WHERE (linked_entity_type = 'home_group'::text);

CREATE INDEX idx_social_pages_owner ON public.social_pages USING btree (owner_id);

CREATE INDEX idx_social_pages_type ON public.social_pages USING btree (page_type);

CREATE INDEX idx_social_pages_venue ON public.social_pages USING btree (linked_venue_id);

ALTER TABLE public."accounting_conversations" ADD CONSTRAINT "accounting_conversations_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES social_conversations(id);

ALTER TABLE public."accounting_conversations" ADD CONSTRAINT "accounting_conversations_recipient_id_fkey" FOREIGN KEY (recipient_id) REFERENCES profiles(id);

ALTER TABLE public."accounting_conversations" ADD CONSTRAINT "accounting_conversations_sender_id_fkey" FOREIGN KEY (sender_id) REFERENCES profiles(id);

ALTER TABLE public."accounting_invoice_deliveries" ADD CONSTRAINT "accounting_invoice_deliveries_invoice_id_fkey" FOREIGN KEY (invoice_id) REFERENCES settlement_invoices(id);

ALTER TABLE public."accounting_invoice_deliveries" ADD CONSTRAINT "accounting_invoice_deliveries_message_id_fkey" FOREIGN KEY (message_id) REFERENCES social_messages(id);

ALTER TABLE public."accounting_invoice_deliveries" ADD CONSTRAINT "accounting_invoice_deliveries_notification_id_fkey" FOREIGN KEY (notification_id) REFERENCES notifications(id);

ALTER TABLE public."accounting_invoice_deliveries" ADD CONSTRAINT "accounting_invoice_deliveries_recipient_id_fkey" FOREIGN KEY (recipient_id) REFERENCES profiles(id);

ALTER TABLE public."agents" ADD CONSTRAINT "agents_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;

ALTER TABLE public."agents" ADD CONSTRAINT "fk_agents_parent" FOREIGN KEY (parent_agent_id) REFERENCES agents(id);

ALTER TABLE public."agents" ADD CONSTRAINT "fk_agents_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public."credit_invoices" ADD CONSTRAINT "credit_invoices_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE public."credit_payments" ADD CONSTRAINT "credit_payments_invoice_id_fkey" FOREIGN KEY (invoice_id) REFERENCES credit_invoices(id) ON DELETE CASCADE;

ALTER TABLE public."notifications" ADD CONSTRAINT "fk_notifications_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public."notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY (actor_id) REFERENCES profiles(id);

ALTER TABLE public."push_outbox" ADD CONSTRAINT "push_outbox_accounting_notification_id_fkey" FOREIGN KEY (accounting_notification_id) REFERENCES notifications(id);

ALTER TABLE public."push_outbox" ADD CONSTRAINT "push_outbox_recipient_user_id_fkey" FOREIGN KEY (recipient_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_adjusts_invoice_id_fkey" FOREIGN KEY (adjusts_invoice_id) REFERENCES settlement_invoices(id);

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_period_id_fkey" FOREIGN KEY (period_id) REFERENCES settlement_periods(id) ON DELETE CASCADE;

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_source_credit_invoice_id_fkey" FOREIGN KEY (source_credit_invoice_id) REFERENCES credit_invoices(id);

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_source_credit_payment_id_fkey" FOREIGN KEY (source_credit_payment_id) REFERENCES credit_payments(id);

ALTER TABLE public."settlement_invoices" ADD CONSTRAINT "settlement_invoices_source_ledger_id_fkey" FOREIGN KEY (source_ledger_id) REFERENCES chip_ledger(id);

ALTER TABLE public."settlement_periods" ADD CONSTRAINT "settlement_periods_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;

ALTER TABLE public."settlement_periods" ADD CONSTRAINT "settlement_periods_union_id_fkey" FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE;

ALTER TABLE public."social_conversation_participants" ADD CONSTRAINT "fk_social_conversation_participants_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public."social_conversation_participants" ADD CONSTRAINT "social_conversation_participants_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES social_conversations(id) ON DELETE CASCADE;

ALTER TABLE public."social_conversations" ADD CONSTRAINT "social_conversations_request_sender_id_fkey" FOREIGN KEY (request_sender_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public."social_messages" ADD CONSTRAINT "fk_social_messages_sender_id_profiles" FOREIGN KEY (sender_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public."social_messages" ADD CONSTRAINT "social_messages_conversation_id_fkey" FOREIGN KEY (conversation_id) REFERENCES social_conversations(id) ON DELETE CASCADE;

ALTER TABLE public."social_pages" ADD CONSTRAINT "fk_social_pages_owner_id_profiles" FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE CASCADE;

ALTER TABLE public."social_pages" ADD CONSTRAINT "fk_social_pages_owner_profile" FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE SET NULL;

ALTER TABLE public."social_pages" ADD CONSTRAINT "social_pages_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;

RESET search_path;
