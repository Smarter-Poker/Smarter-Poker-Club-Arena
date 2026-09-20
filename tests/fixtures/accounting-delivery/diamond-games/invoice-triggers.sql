-- Disposable Diamond bank payout fixture only; never a production migration.
-- Exact read-only catalog source and scope: schema-provenance.json.


SET search_path=public,extensions;

REVOKE ALL PRIVILEGES ON TABLE public."accounting_conversations" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_conversations" TO "postgres";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_conversations" TO "service_role";

ALTER TABLE public."accounting_conversations" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."accounting_conversations" NO FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."accounting_invoice_counters" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_invoice_counters" TO "postgres";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_invoice_counters" TO "service_role";

ALTER TABLE public."accounting_invoice_counters" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."accounting_invoice_counters" NO FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."accounting_invoice_deliveries" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_invoice_deliveries" TO "postgres";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."accounting_invoice_deliveries" TO "service_role";

GRANT SELECT ON TABLE public."accounting_invoice_deliveries" TO "authenticated";

CREATE POLICY "own_accounting_delivery" ON public."accounting_invoice_deliveries" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((recipient_id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public."accounting_invoice_deliveries" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."accounting_invoice_deliveries" NO FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."agents" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."agents" TO "postgres";

GRANT REFERENCES, TRIGGER, MAINTAIN ON TABLE public."agents" TO "anon";

GRANT SELECT, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."agents" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."agents" TO "service_role";

CREATE POLICY "agents_cashier_scoped_read" ON public."agents" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((user_id = ( SELECT auth.uid() AS uid)) OR (fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'all'::text) OR ((fn_club_cashier_scope(club_id, ( SELECT auth.uid() AS uid)) = 'downline'::text) AND fn_club_cashier_can_transact(club_id, ( SELECT auth.uid() AS uid), user_id))));

CREATE POLICY "agents_svc" ON public."agents" AS PERMISSIVE FOR ALL TO "service_role" USING (true);

CREATE POLICY "union_overseer_read" ON public."agents" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));

ALTER TABLE public."agents" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."agents" NO FORCE ROW LEVEL SECURITY;

CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, user_id, parent_agent_id, role, status, commission_rate, player_rakeback_rate, is_prepaid ON agents FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture();

ALTER TABLE public."agents" ENABLE TRIGGER "accounting_agreement_history";

CREATE TRIGGER guard_agent_wallet_direct_update BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION guard_agent_wallet_direct_update();

ALTER TABLE public."agents" ENABLE TRIGGER "guard_agent_wallet_direct_update";

CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy();

ALTER TABLE public."agents" ENABLE TRIGGER "poker_arena_no_hierarchy";

CREATE TRIGGER trg_agents_commission_bounds BEFORE INSERT OR UPDATE OF commission_rate ON agents FOR EACH ROW EXECUTE FUNCTION fn_enforce_agent_commission_bounds();

ALTER TABLE public."agents" ENABLE TRIGGER "trg_agents_commission_bounds";

CREATE TRIGGER trg_agents_human_user_club_only BEFORE INSERT OR UPDATE OF club_id, user_id ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row();

ALTER TABLE public."agents" ENABLE TRIGGER "trg_agents_human_user_club_only";

CREATE TRIGGER trg_agents_staff_earn_no_rakeback BEFORE INSERT OR UPDATE OF role, commission_rate, player_rakeback_rate ON agents FOR EACH ROW WHEN (COALESCE(new.commission_rate, 0::numeric) <> 0::numeric OR COALESCE(new.player_rakeback_rate, 0::numeric) <> 0::numeric) EXECUTE FUNCTION fn_agents_staff_earn_no_rakeback();

ALTER TABLE public."agents" ENABLE TRIGGER "trg_agents_staff_earn_no_rakeback";

CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF agent_wallet_balance, promo_wallet_balance ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet');

ALTER TABLE public."agents" ENABLE TRIGGER "trg_ca_autoledger";

CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet');

ALTER TABLE public."agents" ENABLE TRIGGER "trg_ca_autoledger_delete";

CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON agents FOR EACH ROW WHEN (COALESCE(new.agent_wallet_balance, 0::numeric) <> 0::numeric OR COALESCE(new.promo_wallet_balance, 0::numeric) <> 0::numeric) EXECUTE FUNCTION fn_ca_autoledger('agent_wallet_balance=agent_wallet', 'promo_wallet_balance=promo_wallet');

ALTER TABLE public."agents" ENABLE TRIGGER "trg_ca_autoledger_insert";

CREATE TRIGGER trg_deep_stack_agents_are_protected BEFORE DELETE ON agents FOR EACH ROW WHEN (old.club_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid) EXECUTE FUNCTION fn_deep_stack_society_cannot_be_deleted_by_accident();

ALTER TABLE public."agents" ENABLE TRIGGER "trg_deep_stack_agents_are_protected";

CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();

ALTER TABLE public."agents" ENABLE TRIGGER "trg_guard_retired_club_mutation";

CREATE TRIGGER trg_sync_agent_wallets BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION sync_agent_wallet_columns();

ALTER TABLE public."agents" ENABLE TRIGGER "trg_sync_agent_wallets";

REVOKE ALL PRIVILEGES ON TABLE public."credit_invoices" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."credit_invoices" TO "postgres";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."credit_invoices" TO "anon";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."credit_invoices" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."credit_invoices" TO "service_role";

CREATE POLICY "credit_invoices_select_own" ON public."credit_invoices" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((agent_id IN ( SELECT a.id
   FROM agents a
  WHERE (a.user_id = ( SELECT auth.uid() AS uid)))));

ALTER TABLE public."credit_invoices" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."credit_invoices" NO FORCE ROW LEVEL SECURITY;

CREATE TRIGGER accounting_credit_invoice_document AFTER INSERT ON credit_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_credit_document_on_insert();

ALTER TABLE public."credit_invoices" ENABLE TRIGGER "accounting_credit_invoice_document";

CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON credit_invoices FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();

ALTER TABLE public."credit_invoices" ENABLE TRIGGER "trg_guard_retired_club_mutation";

REVOKE ALL PRIVILEGES ON TABLE public."credit_payments" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."credit_payments" TO "postgres";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."credit_payments" TO "anon";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."credit_payments" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."credit_payments" TO "service_role";

CREATE POLICY "credit_payments_select_own" ON public."credit_payments" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((invoice_id IN ( SELECT ci.id
   FROM (credit_invoices ci
     JOIN agents a ON ((a.id = ci.agent_id)))
  WHERE (a.user_id = ( SELECT auth.uid() AS uid)))));

ALTER TABLE public."credit_payments" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."credit_payments" NO FORCE ROW LEVEL SECURITY;

CREATE TRIGGER accounting_credit_payment_document AFTER INSERT ON credit_payments FOR EACH ROW EXECUTE FUNCTION fn_accounting_credit_document_on_insert();

ALTER TABLE public."credit_payments" ENABLE TRIGGER "accounting_credit_payment_document";

REVOKE ALL PRIVILEGES ON TABLE public."notifications" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."notifications" TO "postgres";

GRANT INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."notifications" TO "anon";

GRANT INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."notifications" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."notifications" TO "service_role";

CREATE POLICY "Service role inserts" ON public."notifications" AS PERMISSIVE FOR INSERT TO "service_role" WITH CHECK (true);

CREATE POLICY "Users can delete own notifications" ON public."notifications" AS PERMISSIVE FOR DELETE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));

CREATE POLICY "Users can update own notifications" ON public."notifications" AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));

CREATE POLICY "Users can view own notifications" ON public."notifications" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((( SELECT auth.uid() AS uid) = user_id));

ALTER TABLE public."notifications" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."notifications" NO FORCE ROW LEVEL SECURITY;

CREATE CONSTRAINT TRIGGER trg_accounting_push_after_delivery AFTER INSERT ON notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.type = 'accounting_invoice'::text) EXECUTE FUNCTION fn_mirror_notification_to_push_outbox();

ALTER TABLE public."notifications" ENABLE TRIGGER "trg_accounting_push_after_delivery";

CREATE TRIGGER trg_mirror_notification_to_push_outbox AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fn_mirror_notification_to_push_outbox();

ALTER TABLE public."notifications" ENABLE TRIGGER "trg_mirror_notification_to_push_outbox";

CREATE TRIGGER trg_notification_fill_action_url BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fn_notification_fill_action_url();

ALTER TABLE public."notifications" ENABLE TRIGGER "trg_notification_fill_action_url";

CREATE TRIGGER trg_sync_notification_read_state BEFORE INSERT OR UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION sync_notification_read_state();

ALTER TABLE public."notifications" ENABLE TRIGGER "trg_sync_notification_read_state";

REVOKE ALL PRIVILEGES ON TABLE public."push_outbox" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."push_outbox" TO "postgres";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."push_outbox" TO "anon";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."push_outbox" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."push_outbox" TO "service_role";

CREATE POLICY "admin reads push outbox" ON public."push_outbox" AS PERMISSIVE FOR SELECT TO PUBLIC USING (is_admin());

ALTER TABLE public."push_outbox" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."push_outbox" NO FORCE ROW LEVEL SECURITY;

CREATE TRIGGER claim_tournament_reminder_before_enqueue BEFORE INSERT ON push_outbox FOR EACH ROW WHEN (new.event = ANY (ARRAY['tournament_reminder_15m'::text, 'tournament_reminder_2m'::text])) EXECUTE FUNCTION trg_claim_tournament_reminder();

ALTER TABLE public."push_outbox" ENABLE TRIGGER "claim_tournament_reminder_before_enqueue";

REVOKE ALL PRIVILEGES ON TABLE public."settlement_invoices" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."settlement_invoices" TO "postgres";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."settlement_invoices" TO "anon";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."settlement_invoices" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."settlement_invoices" TO "service_role";

CREATE POLICY "own_accounting_invoice" ON public."settlement_invoices" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM accounting_invoice_deliveries d
  WHERE ((d.invoice_id = settlement_invoices.id) AND (d.recipient_id = ( SELECT auth.uid() AS uid))))));

CREATE POLICY "settlement_invoices_club_admin_select" ON public."settlement_invoices" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((fn_is_platform_admin() OR fn_is_club_admin_uid(club_id)));

CREATE POLICY "union_overseer_read" ON public."settlement_invoices" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));

ALTER TABLE public."settlement_invoices" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."settlement_invoices" NO FORCE ROW LEVEL SECURITY;

CREATE TRIGGER accounting_invoice_deliver AFTER INSERT ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_invoice_deliver_on_insert();

ALTER TABLE public."settlement_invoices" ENABLE TRIGGER "accounting_invoice_deliver";

CREATE TRIGGER accounting_invoice_immutable BEFORE DELETE OR UPDATE ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_document_immutable();

ALTER TABLE public."settlement_invoices" ENABLE TRIGGER "accounting_invoice_immutable";

REVOKE ALL PRIVILEGES ON TABLE public."settlement_periods" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."settlement_periods" TO "postgres";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."settlement_periods" TO "anon";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."settlement_periods" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."settlement_periods" TO "service_role";

CREATE POLICY "settlement_read" ON public."settlement_periods" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM club_members cm
  WHERE ((cm.club_id = settlement_periods.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'agent'::text]))))));

CREATE POLICY "settlement_svc" ON public."settlement_periods" AS PERMISSIVE FOR ALL TO "service_role" USING (true);

CREATE POLICY "union_overseer_read" ON public."settlement_periods" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid))));

ALTER TABLE public."settlement_periods" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."settlement_periods" NO FORCE ROW LEVEL SECURITY;

CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON settlement_periods FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();

ALTER TABLE public."settlement_periods" ENABLE TRIGGER "trg_guard_retired_club_mutation";

CREATE TRIGGER zz_closed_period_is_immutable BEFORE DELETE OR UPDATE ON settlement_periods FOR EACH ROW EXECUTE FUNCTION zz_closed_period_is_immutable();

ALTER TABLE public."settlement_periods" ENABLE TRIGGER "zz_closed_period_is_immutable";

REVOKE ALL PRIVILEGES ON TABLE public."social_conversation_participants" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_conversation_participants" TO "postgres";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."social_conversation_participants" TO "anon";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."social_conversation_participants" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_conversation_participants" TO "service_role";

CREATE POLICY "Service role manages" ON public."social_conversation_participants" AS PERMISSIVE FOR ALL TO "service_role" USING (true);

CREATE POLICY "Users can view their own participation" ON public."social_conversation_participants" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((user_id = ( SELECT auth.uid() AS uid)));

ALTER TABLE public."social_conversation_participants" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."social_conversation_participants" NO FORCE ROW LEVEL SECURITY;

CREATE TRIGGER accounting_conversation_audience BEFORE INSERT OR DELETE OR UPDATE ON social_conversation_participants FOR EACH ROW EXECUTE FUNCTION fn_accounting_conversation_audience_guard();

ALTER TABLE public."social_conversation_participants" ENABLE TRIGGER "accounting_conversation_audience";

REVOKE ALL PRIVILEGES ON TABLE public."social_conversations" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_conversations" TO "postgres";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."social_conversations" TO "anon";

GRANT SELECT, REFERENCES, TRIGGER ON TABLE public."social_conversations" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_conversations" TO "service_role";

CREATE POLICY "Service role manages" ON public."social_conversations" AS PERMISSIVE FOR ALL TO "service_role" USING (true);

CREATE POLICY "Users can view their conversations" ON public."social_conversations" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM social_conversation_participants
  WHERE ((social_conversation_participants.conversation_id = social_conversations.id) AND (social_conversation_participants.user_id = ( SELECT auth.uid() AS uid))))));

ALTER TABLE public."social_conversations" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."social_conversations" NO FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."social_messages" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_messages" TO "postgres";

GRANT INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_messages" TO "anon";

GRANT INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_messages" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_messages" TO "service_role";

CREATE POLICY "Users can send messages" ON public."social_messages" AS PERMISSIVE FOR INSERT TO PUBLIC WITH CHECK (((sender_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM social_conversation_participants scp
  WHERE ((scp.conversation_id = social_messages.conversation_id) AND (scp.user_id = ( SELECT auth.uid() AS uid)))))));

CREATE POLICY "Users can update their messages" ON public."social_messages" AS PERMISSIVE FOR UPDATE TO PUBLIC USING ((sender_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((sender_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "Users can view conversation messages" ON public."social_messages" AS PERMISSIVE FOR SELECT TO PUBLIC USING ((EXISTS ( SELECT 1
   FROM social_conversation_participants scp
  WHERE ((scp.conversation_id = social_messages.conversation_id) AND (scp.user_id = ( SELECT auth.uid() AS uid))))));

ALTER TABLE public."social_messages" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."social_messages" NO FORCE ROW LEVEL SECURITY;

CREATE TRIGGER accounting_discussion_observed AFTER INSERT ON social_messages FOR EACH ROW WHEN (COALESCE(new.message_type, 'text'::text) <> ALL (ARRAY['invoice'::text, 'system'::text])) EXECUTE FUNCTION fn_accounting_discussion_observed();

ALTER TABLE public."social_messages" ENABLE TRIGGER "accounting_discussion_observed";

CREATE TRIGGER accounting_message_immutable BEFORE DELETE OR UPDATE ON social_messages FOR EACH ROW EXECUTE FUNCTION fn_accounting_document_immutable();

ALTER TABLE public."social_messages" ENABLE TRIGGER "accounting_message_immutable";

CREATE TRIGGER trg_block_message_field_reassignment BEFORE UPDATE ON social_messages FOR EACH ROW EXECUTE FUNCTION fn_block_message_field_reassignment();

ALTER TABLE public."social_messages" ENABLE TRIGGER "trg_block_message_field_reassignment";

CREATE TRIGGER trg_live_invite_notification AFTER INSERT ON social_messages FOR EACH ROW EXECUTE FUNCTION trg_fn_live_invite_notification();

ALTER TABLE public."social_messages" ENABLE TRIGGER "trg_live_invite_notification";

CREATE TRIGGER trg_update_conversation_last_message AFTER INSERT ON social_messages FOR EACH ROW EXECUTE FUNCTION fn_update_conversation_last_message();

ALTER TABLE public."social_messages" ENABLE TRIGGER "trg_update_conversation_last_message";

REVOKE ALL PRIVILEGES ON TABLE public."social_pages" FROM PUBLIC, anon, authenticated, service_role;

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_pages" TO "postgres";

GRANT INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_pages" TO "anon";

GRANT INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_pages" TO "authenticated";

GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public."social_pages" TO "service_role";

CREATE POLICY "social_pages_owner_write" ON public."social_pages" AS PERMISSIVE FOR ALL TO "authenticated" USING ((( SELECT auth.uid() AS uid) = owner_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = owner_id));

CREATE POLICY "social_pages_read" ON public."social_pages" AS PERMISSIVE FOR SELECT TO PUBLIC USING (((COALESCE(is_public, false) = true) OR (owner_id = ( SELECT auth.uid() AS uid))));

ALTER TABLE public."social_pages" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public."social_pages" NO FORCE ROW LEVEL SECURITY;

DO $invoice_catalog_witness$ BEGIN
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_conversations'::regclass AND conname='accounting_conversations_conversation_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (conversation_id) REFERENCES social_conversations(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_conversations.accounting_conversations_conversation_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_conversations'::regclass AND conname='accounting_conversations_pkey') IS DISTINCT FROM 'PRIMARY KEY (scope_id, issuer_type, issuer_id, sender_id, recipient_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_conversations.accounting_conversations_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_conversations'::regclass AND conname='accounting_conversations_recipient_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (recipient_id) REFERENCES profiles(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_conversations.accounting_conversations_recipient_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_conversations'::regclass AND conname='accounting_conversations_sender_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (sender_id) REFERENCES profiles(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_conversations.accounting_conversations_sender_id_fkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.accounting_conversations_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX accounting_conversations_pkey ON public.accounting_conversations USING btree (scope_id, issuer_type, issuer_id, sender_id, recipient_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: accounting_conversations_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_counters'::regclass AND conname='accounting_invoice_counters_next_number_check') IS DISTINCT FROM 'CHECK (next_number > 0)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_counters.accounting_invoice_counters_next_number_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_counters'::regclass AND conname='accounting_invoice_counters_pkey') IS DISTINCT FROM 'PRIMARY KEY (year)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_counters.accounting_invoice_counters_pkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.accounting_invoice_counters_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX accounting_invoice_counters_pkey ON public.accounting_invoice_counters USING btree (year)' THEN RAISE EXCEPTION 'Invoice index witness failed: accounting_invoice_counters_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_deliveries'::regclass AND conname='accounting_invoice_deliveries_delivery_mode_check') IS DISTINCT FROM 'CHECK (delivery_mode = ANY (ARRAY[''immediate''::text, ''weekly_detail''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_deliveries.accounting_invoice_deliveries_delivery_mode_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_deliveries'::regclass AND conname='accounting_invoice_deliveries_invoice_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (invoice_id) REFERENCES settlement_invoices(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_deliveries.accounting_invoice_deliveries_invoice_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_deliveries'::regclass AND conname='accounting_invoice_deliveries_message_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (message_id) REFERENCES social_messages(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_deliveries.accounting_invoice_deliveries_message_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_deliveries'::regclass AND conname='accounting_invoice_deliveries_message_id_key') IS DISTINCT FROM 'UNIQUE (message_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_deliveries.accounting_invoice_deliveries_message_id_key'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_deliveries'::regclass AND conname='accounting_invoice_deliveries_notification_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (notification_id) REFERENCES notifications(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_deliveries.accounting_invoice_deliveries_notification_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_deliveries'::regclass AND conname='accounting_invoice_deliveries_notification_id_key') IS DISTINCT FROM 'UNIQUE (notification_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_deliveries.accounting_invoice_deliveries_notification_id_key'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_deliveries'::regclass AND conname='accounting_invoice_deliveries_pkey') IS DISTINCT FROM 'PRIMARY KEY (invoice_id, recipient_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_deliveries.accounting_invoice_deliveries_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.accounting_invoice_deliveries'::regclass AND conname='accounting_invoice_deliveries_recipient_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (recipient_id) REFERENCES profiles(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: accounting_invoice_deliveries.accounting_invoice_deliveries_recipient_id_fkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.accounting_invoice_deliveries_message_id_key')) IS DISTINCT FROM 'CREATE UNIQUE INDEX accounting_invoice_deliveries_message_id_key ON public.accounting_invoice_deliveries USING btree (message_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: accounting_invoice_deliveries_message_id_key'; END IF;
  IF pg_get_indexdef(to_regclass('public.accounting_invoice_deliveries_notification_id_key')) IS DISTINCT FROM 'CREATE UNIQUE INDEX accounting_invoice_deliveries_notification_id_key ON public.accounting_invoice_deliveries USING btree (notification_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: accounting_invoice_deliveries_notification_id_key'; END IF;
  IF pg_get_indexdef(to_regclass('public.accounting_invoice_deliveries_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX accounting_invoice_deliveries_pkey ON public.accounting_invoice_deliveries USING btree (invoice_id, recipient_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: accounting_invoice_deliveries_pkey'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='accounting_agreement_history') IS DISTINCT FROM 'CREATE TRIGGER accounting_agreement_history AFTER INSERT OR DELETE OR UPDATE OF id, club_id, user_id, parent_agent_id, role, status, commission_rate, player_rakeback_rate, is_prepaid ON agents FOR EACH ROW EXECUTE FUNCTION fn_accounting_agreement_capture()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='accounting_agreement_history') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.accounting_agreement_history'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='guard_agent_wallet_direct_update') IS DISTINCT FROM 'CREATE TRIGGER guard_agent_wallet_direct_update BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION guard_agent_wallet_direct_update()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='guard_agent_wallet_direct_update') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.guard_agent_wallet_direct_update'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='poker_arena_no_hierarchy') IS DISTINCT FROM 'CREATE TRIGGER poker_arena_no_hierarchy BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_poker_reject_diamond_hierarchy()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='poker_arena_no_hierarchy') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.poker_arena_no_hierarchy'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_agents_commission_bounds') IS DISTINCT FROM 'CREATE TRIGGER trg_agents_commission_bounds BEFORE INSERT OR UPDATE OF commission_rate ON agents FOR EACH ROW EXECUTE FUNCTION fn_enforce_agent_commission_bounds()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_agents_commission_bounds') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.trg_agents_commission_bounds'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_agents_human_user_club_only') IS DISTINCT FROM 'CREATE TRIGGER trg_agents_human_user_club_only BEFORE INSERT OR UPDATE OF club_id, user_id ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_reject_automated_user_club_row()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_agents_human_user_club_only') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.trg_agents_human_user_club_only'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_agents_staff_earn_no_rakeback') IS DISTINCT FROM 'CREATE TRIGGER trg_agents_staff_earn_no_rakeback BEFORE INSERT OR UPDATE OF role, commission_rate, player_rakeback_rate ON agents FOR EACH ROW WHEN (COALESCE(new.commission_rate, 0::numeric) <> 0::numeric OR COALESCE(new.player_rakeback_rate, 0::numeric) <> 0::numeric) EXECUTE FUNCTION fn_agents_staff_earn_no_rakeback()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_agents_staff_earn_no_rakeback') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.trg_agents_staff_earn_no_rakeback'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_ca_autoledger') IS DISTINCT FROM 'CREATE TRIGGER trg_ca_autoledger AFTER UPDATE OF agent_wallet_balance, promo_wallet_balance ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger(''agent_wallet_balance=agent_wallet'', ''promo_wallet_balance=promo_wallet'')' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_ca_autoledger') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.trg_ca_autoledger'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_ca_autoledger_delete') IS DISTINCT FROM 'CREATE TRIGGER trg_ca_autoledger_delete BEFORE DELETE ON agents FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger_delete(''agent_wallet_balance=agent_wallet'', ''promo_wallet_balance=promo_wallet'')' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_ca_autoledger_delete') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.trg_ca_autoledger_delete'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_ca_autoledger_insert') IS DISTINCT FROM 'CREATE TRIGGER trg_ca_autoledger_insert AFTER INSERT ON agents FOR EACH ROW WHEN (COALESCE(new.agent_wallet_balance, 0::numeric) <> 0::numeric OR COALESCE(new.promo_wallet_balance, 0::numeric) <> 0::numeric) EXECUTE FUNCTION fn_ca_autoledger(''agent_wallet_balance=agent_wallet'', ''promo_wallet_balance=promo_wallet'')' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_ca_autoledger_insert') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.trg_ca_autoledger_insert'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_deep_stack_agents_are_protected') IS DISTINCT FROM 'CREATE TRIGGER trg_deep_stack_agents_are_protected BEFORE DELETE ON agents FOR EACH ROW WHEN (old.club_id = ''2a1132b9-5ba2-42e6-9f01-30a7fcffebe3''::uuid) EXECUTE FUNCTION fn_deep_stack_society_cannot_be_deleted_by_accident()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_deep_stack_agents_are_protected') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.trg_deep_stack_agents_are_protected'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_guard_retired_club_mutation') IS DISTINCT FROM 'CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_guard_retired_club_mutation') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.trg_guard_retired_club_mutation'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_sync_agent_wallets') IS DISTINCT FROM 'CREATE TRIGGER trg_sync_agent_wallets BEFORE UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION sync_agent_wallet_columns()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.agents'::regclass AND tgname='trg_sync_agent_wallets') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: agents.trg_sync_agent_wallets'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_agent_wallet_balance_nonneg') IS DISTINCT FROM 'CHECK (agent_wallet_balance >= 0::numeric)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_agent_wallet_balance_nonneg'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_club_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_club_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_club_id_user_id_key') IS DISTINCT FROM 'UNIQUE (club_id, user_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_club_id_user_id_key'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_commission_rate_check') IS DISTINCT FROM 'CHECK (commission_rate >= 0::numeric AND commission_rate <= 0.70)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_commission_rate_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_credit_used_check') IS DISTINCT FROM 'CHECK (credit_used >= 0::numeric)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_credit_used_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_player_rakeback_rate_check') IS DISTINCT FROM 'CHECK (player_rakeback_rate >= 0::numeric AND player_rakeback_rate <= 0.50)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_player_rakeback_rate_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_promo_wallet_balance_nonneg') IS DISTINCT FROM 'CHECK (promo_wallet_balance >= 0::numeric)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_promo_wallet_balance_nonneg'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_role_check') IS DISTINCT FROM 'CHECK (role = ANY (ARRAY[''super_agent''::text, ''agent''::text, ''sub_agent''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_role_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='agents_status_check') IS DISTINCT FROM 'CHECK (status = ANY (ARRAY[''active''::text, ''suspended''::text, ''frozen''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.agents_status_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='check_credit') IS DISTINCT FROM 'CHECK (credit_used <= credit_limit OR is_prepaid = true)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.check_credit'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='chk_player_wallet_balance_is_two_decimal_places') IS DISTINCT FROM 'CHECK (player_wallet_balance IS NULL OR player_wallet_balance = round(player_wallet_balance, 2))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.chk_player_wallet_balance_is_two_decimal_places'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='fk_agents_parent') IS DISTINCT FROM 'FOREIGN KEY (parent_agent_id) REFERENCES agents(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.fk_agents_parent'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.agents'::regclass AND conname='fk_agents_user_id_profiles') IS DISTINCT FROM 'FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: agents.fk_agents_user_id_profiles'; END IF;
  IF pg_get_indexdef(to_regclass('public.agents_club_id_user_id_key')) IS DISTINCT FROM 'CREATE UNIQUE INDEX agents_club_id_user_id_key ON public.agents USING btree (club_id, user_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: agents_club_id_user_id_key'; END IF;
  IF pg_get_indexdef(to_regclass('public.agents_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: agents_pkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_agents_club')) IS DISTINCT FROM 'CREATE INDEX idx_agents_club ON public.agents USING btree (club_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_agents_club'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_agents_parent')) IS DISTINCT FROM 'CREATE INDEX idx_agents_parent ON public.agents USING btree (parent_agent_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_agents_parent'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_agents_user')) IS DISTINCT FROM 'CREATE INDEX idx_agents_user ON public.agents USING btree (user_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_agents_user'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.credit_invoices'::regclass AND tgname='accounting_credit_invoice_document') IS DISTINCT FROM 'CREATE TRIGGER accounting_credit_invoice_document AFTER INSERT ON credit_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_credit_document_on_insert()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.credit_invoices'::regclass AND tgname='accounting_credit_invoice_document') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: credit_invoices.accounting_credit_invoice_document'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.credit_invoices'::regclass AND tgname='trg_guard_retired_club_mutation') IS DISTINCT FROM 'CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON credit_invoices FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.credit_invoices'::regclass AND tgname='trg_guard_retired_club_mutation') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: credit_invoices.trg_guard_retired_club_mutation'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_invoices'::regclass AND conname='credit_invoices_agent_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_invoices.credit_invoices_agent_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_invoices'::regclass AND conname='credit_invoices_amount_paid_check') IS DISTINCT FROM 'CHECK (amount_paid >= 0::numeric)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_invoices.credit_invoices_amount_paid_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_invoices'::regclass AND conname='credit_invoices_amount_remaining_check') IS DISTINCT FROM 'CHECK (amount_remaining >= 0::numeric)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_invoices.credit_invoices_amount_remaining_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_invoices'::regclass AND conname='credit_invoices_debt_owed_check') IS DISTINCT FROM 'CHECK (debt_owed >= 0::numeric)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_invoices.credit_invoices_debt_owed_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_invoices'::regclass AND conname='credit_invoices_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_invoices.credit_invoices_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_invoices'::regclass AND conname='credit_invoices_status_check') IS DISTINCT FROM 'CHECK (status = ANY (ARRAY[''pending''::text, ''partial''::text, ''paid''::text, ''overdue''::text, ''disputed''::text, ''void''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_invoices.credit_invoices_status_check'; END IF;
  IF pg_get_indexdef(to_regclass('public.credit_invoices_agent_period_uidx')) IS DISTINCT FROM 'CREATE UNIQUE INDEX credit_invoices_agent_period_uidx ON public.credit_invoices USING btree (agent_id, period_end)' THEN RAISE EXCEPTION 'Invoice index witness failed: credit_invoices_agent_period_uidx'; END IF;
  IF pg_get_indexdef(to_regclass('public.credit_invoices_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX credit_invoices_pkey ON public.credit_invoices USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: credit_invoices_pkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_credit_invoices_agent')) IS DISTINCT FROM 'CREATE INDEX idx_credit_invoices_agent ON public.credit_invoices USING btree (agent_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_credit_invoices_agent'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_credit_invoices_duedate')) IS DISTINCT FROM 'CREATE INDEX idx_credit_invoices_duedate ON public.credit_invoices USING btree (due_date)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_credit_invoices_duedate'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.credit_payments'::regclass AND tgname='accounting_credit_payment_document') IS DISTINCT FROM 'CREATE TRIGGER accounting_credit_payment_document AFTER INSERT ON credit_payments FOR EACH ROW EXECUTE FUNCTION fn_accounting_credit_document_on_insert()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.credit_payments'::regclass AND tgname='accounting_credit_payment_document') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: credit_payments.accounting_credit_payment_document'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_payments'::regclass AND conname='credit_payments_amount_check') IS DISTINCT FROM 'CHECK (amount > 0::numeric)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_payments.credit_payments_amount_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_payments'::regclass AND conname='credit_payments_invoice_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (invoice_id) REFERENCES credit_invoices(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_payments.credit_payments_invoice_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_payments'::regclass AND conname='credit_payments_operation_id_key') IS DISTINCT FROM 'UNIQUE (operation_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_payments.credit_payments_operation_id_key'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_payments'::regclass AND conname='credit_payments_payment_method_check') IS DISTINCT FROM 'CHECK (payment_method = ANY (ARRAY[''wallet''::text, ''diamonds''::text, ''external''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_payments.credit_payments_payment_method_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.credit_payments'::regclass AND conname='credit_payments_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: credit_payments.credit_payments_pkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.credit_payments_external_reference')) IS DISTINCT FROM 'CREATE UNIQUE INDEX credit_payments_external_reference ON public.credit_payments USING btree (invoice_id, payment_reference) WHERE ((payment_method = ''external''::text) AND (payment_reference IS NOT NULL))' THEN RAISE EXCEPTION 'Invoice index witness failed: credit_payments_external_reference'; END IF;
  IF pg_get_indexdef(to_regclass('public.credit_payments_operation_id_key')) IS DISTINCT FROM 'CREATE UNIQUE INDEX credit_payments_operation_id_key ON public.credit_payments USING btree (operation_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: credit_payments_operation_id_key'; END IF;
  IF pg_get_indexdef(to_regclass('public.credit_payments_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX credit_payments_pkey ON public.credit_payments USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: credit_payments_pkey'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_accounting_push_after_delivery') IS DISTINCT FROM 'CREATE CONSTRAINT TRIGGER trg_accounting_push_after_delivery AFTER INSERT ON notifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.type = ''accounting_invoice''::text) EXECUTE FUNCTION fn_mirror_notification_to_push_outbox()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_accounting_push_after_delivery') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: notifications.trg_accounting_push_after_delivery'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_mirror_notification_to_push_outbox') IS DISTINCT FROM 'CREATE TRIGGER trg_mirror_notification_to_push_outbox AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fn_mirror_notification_to_push_outbox()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_mirror_notification_to_push_outbox') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: notifications.trg_mirror_notification_to_push_outbox'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_notification_fill_action_url') IS DISTINCT FROM 'CREATE TRIGGER trg_notification_fill_action_url BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION fn_notification_fill_action_url()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_notification_fill_action_url') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: notifications.trg_notification_fill_action_url'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_sync_notification_read_state') IS DISTINCT FROM 'CREATE TRIGGER trg_sync_notification_read_state BEFORE INSERT OR UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION sync_notification_read_state()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.notifications'::regclass AND tgname='trg_sync_notification_read_state') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: notifications.trg_sync_notification_read_state'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.notifications'::regclass AND conname='fk_notifications_user_id_profiles') IS DISTINCT FROM 'FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: notifications.fk_notifications_user_id_profiles'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.notifications'::regclass AND conname='notifications_actor_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (actor_id) REFERENCES profiles(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: notifications.notifications_actor_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.notifications'::regclass AND conname='notifications_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: notifications.notifications_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.notifications'::regclass AND conname='trg_accounting_push_after_delivery') IS DISTINCT FROM 'TRIGGER DEFERRABLE INITIALLY DEFERRED' THEN RAISE EXCEPTION 'Invoice constraint witness failed: notifications.trg_accounting_push_after_delivery'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_notif_dedup_friend_request')) IS DISTINCT FROM 'CREATE UNIQUE INDEX idx_notif_dedup_friend_request ON public.notifications USING btree (user_id, type, ((data ->> ''sender_id''::text))) WHERE (type = ''friend_request''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_notif_dedup_friend_request'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_notif_dedup_group_friend')) IS DISTINCT FROM 'CREATE UNIQUE INDEX idx_notif_dedup_group_friend ON public.notifications USING btree (user_id, type, ((data ->> ''group_id''::text)), ((data ->> ''friend_id''::text))) WHERE (type = ''home_group_friend_joined''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_notif_dedup_group_friend'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_notifications_actor_id')) IS DISTINCT FROM 'CREATE INDEX idx_notifications_actor_id ON public.notifications USING btree (actor_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_notifications_actor_id'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_notifications_user_all')) IS DISTINCT FROM 'CREATE INDEX idx_notifications_user_all ON public.notifications USING btree (user_id, created_at DESC)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_notifications_user_all'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_notifications_user_id')) IS DISTINCT FROM 'CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_notifications_user_id'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_notifications_user_id_id')) IS DISTINCT FROM 'CREATE INDEX idx_notifications_user_id_id ON public.notifications USING btree (user_id, id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_notifications_user_id_id'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_notifications_user_type_read')) IS DISTINCT FROM 'CREATE INDEX idx_notifications_user_type_read ON public.notifications USING btree (user_id, type, read, created_at DESC)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_notifications_user_type_read'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_notifications_user_unread')) IS DISTINCT FROM 'CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id, read, created_at DESC) WHERE (read = false)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_notifications_user_unread'; END IF;
  IF pg_get_indexdef(to_regclass('public.notifications_daily_mission_cycle_unique')) IS DISTINCT FROM 'CREATE UNIQUE INDEX notifications_daily_mission_cycle_unique ON public.notifications USING btree (user_id, ((data ->> ''cycle_date''::text))) WHERE ((type = ''daily_challenge''::text) AND ((data ->> ''source''::text) = ''club_arena_daily_missions''::text))' THEN RAISE EXCEPTION 'Invoice index witness failed: notifications_daily_mission_cycle_unique'; END IF;
  IF pg_get_indexdef(to_regclass('public.notifications_pa_leak_audit_job_unique')) IS DISTINCT FROM 'CREATE UNIQUE INDEX notifications_pa_leak_audit_job_unique ON public.notifications USING btree (((data ->> ''paAuditJobId''::text))) WHERE ((type = ''personal_assistant_audit_complete''::text) AND (data ? ''paAuditJobId''::text))' THEN RAISE EXCEPTION 'Invoice index witness failed: notifications_pa_leak_audit_job_unique'; END IF;
  IF pg_get_indexdef(to_regclass('public.notifications_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX notifications_pkey ON public.notifications USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: notifications_pkey'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.push_outbox'::regclass AND tgname='claim_tournament_reminder_before_enqueue') IS DISTINCT FROM 'CREATE TRIGGER claim_tournament_reminder_before_enqueue BEFORE INSERT ON push_outbox FOR EACH ROW WHEN (new.event = ANY (ARRAY[''tournament_reminder_15m''::text, ''tournament_reminder_2m''::text])) EXECUTE FUNCTION trg_claim_tournament_reminder()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.push_outbox'::regclass AND tgname='claim_tournament_reminder_before_enqueue') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: push_outbox.claim_tournament_reminder_before_enqueue'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.push_outbox'::regclass AND conname='accounting_push_deferral_requires_typed_receipt') IS DISTINCT FROM 'CHECK (next_attempt_at IS NULL OR accounting_notification_id IS NOT NULL AND isfinite(next_attempt_at))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: push_outbox.accounting_push_deferral_requires_typed_receipt'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.push_outbox'::regclass AND conname='accounting_push_notification_identity') IS DISTINCT FROM 'CHECK (accounting_notification_id IS NULL OR NOT event IS DISTINCT FROM ''accounting_invoice''::text AND NOT related_entity_id IS DISTINCT FROM accounting_notification_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: push_outbox.accounting_push_notification_identity'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.push_outbox'::regclass AND conname='push_outbox_accounting_notification_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (accounting_notification_id) REFERENCES notifications(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: push_outbox.push_outbox_accounting_notification_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.push_outbox'::regclass AND conname='push_outbox_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: push_outbox.push_outbox_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.push_outbox'::regclass AND conname='push_outbox_recipient_user_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (recipient_user_id) REFERENCES auth.users(id) ON DELETE SET NULL' THEN RAISE EXCEPTION 'Invoice constraint witness failed: push_outbox.push_outbox_recipient_user_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.push_outbox'::regclass AND conname='push_outbox_status_check') IS DISTINCT FROM 'CHECK (status = ANY (ARRAY[''pending''::text, ''processing''::text, ''sent''::text, ''failed''::text, ''skipped''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: push_outbox.push_outbox_status_check'; END IF;
  IF pg_get_indexdef(to_regclass('public.accounting_push_deferred_due')) IS DISTINCT FROM 'CREATE INDEX accounting_push_deferred_due ON public.push_outbox USING btree (next_attempt_at, id) WHERE ((status = ''pending''::text) AND (next_attempt_at IS NOT NULL))' THEN RAISE EXCEPTION 'Invoice index witness failed: accounting_push_deferred_due'; END IF;
  IF pg_get_indexdef(to_regclass('public.accounting_push_one_notification_receipt')) IS DISTINCT FROM 'CREATE UNIQUE INDEX accounting_push_one_notification_receipt ON public.push_outbox USING btree (accounting_notification_id) WHERE (accounting_notification_id IS NOT NULL)' THEN RAISE EXCEPTION 'Invoice index witness failed: accounting_push_one_notification_receipt'; END IF;
  IF pg_get_indexdef(to_regclass('public.push_outbox_event_idx')) IS DISTINCT FROM 'CREATE INDEX push_outbox_event_idx ON public.push_outbox USING btree (event, created_at DESC)' THEN RAISE EXCEPTION 'Invoice index witness failed: push_outbox_event_idx'; END IF;
  IF pg_get_indexdef(to_regclass('public.push_outbox_pending_idx')) IS DISTINCT FROM 'CREATE INDEX push_outbox_pending_idx ON public.push_outbox USING btree (status, created_at) WHERE (status = ''pending''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: push_outbox_pending_idx'; END IF;
  IF pg_get_indexdef(to_regclass('public.push_outbox_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX push_outbox_pkey ON public.push_outbox USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: push_outbox_pkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.push_outbox_processing_claimed_idx')) IS DISTINCT FROM 'CREATE INDEX push_outbox_processing_claimed_idx ON public.push_outbox USING btree (claimed_at) WHERE (status = ''processing''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: push_outbox_processing_claimed_idx'; END IF;
  IF pg_get_indexdef(to_regclass('public.push_outbox_recipient_idx')) IS DISTINCT FROM 'CREATE INDEX push_outbox_recipient_idx ON public.push_outbox USING btree (recipient_user_id, created_at DESC)' THEN RAISE EXCEPTION 'Invoice index witness failed: push_outbox_recipient_idx'; END IF;
  IF pg_get_indexdef(to_regclass('public.push_outbox_recipient_pending_idx')) IS DISTINCT FROM 'CREATE INDEX push_outbox_recipient_pending_idx ON public.push_outbox USING btree (recipient_user_id) WHERE (status = ANY (ARRAY[''pending''::text, ''processing''::text]))' THEN RAISE EXCEPTION 'Invoice index witness failed: push_outbox_recipient_pending_idx'; END IF;
  IF pg_get_indexdef(to_regclass('public.push_outbox_recipient_sent_idx')) IS DISTINCT FROM 'CREATE INDEX push_outbox_recipient_sent_idx ON public.push_outbox USING btree (recipient_user_id, sent_at DESC) WHERE (status = ''sent''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: push_outbox_recipient_sent_idx'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.settlement_invoices'::regclass AND tgname='accounting_invoice_deliver') IS DISTINCT FROM 'CREATE TRIGGER accounting_invoice_deliver AFTER INSERT ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_invoice_deliver_on_insert()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.settlement_invoices'::regclass AND tgname='accounting_invoice_deliver') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: settlement_invoices.accounting_invoice_deliver'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.settlement_invoices'::regclass AND tgname='accounting_invoice_immutable') IS DISTINCT FROM 'CREATE TRIGGER accounting_invoice_immutable BEFORE DELETE OR UPDATE ON settlement_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_document_immutable()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.settlement_invoices'::regclass AND tgname='accounting_invoice_immutable') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: settlement_invoices.accounting_invoice_immutable'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='accounting_invoice_has_one_source') IS DISTINCT FROM 'CHECK (num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) <= 1 AND (period_id IS NOT NULL OR num_nonnulls(source_ledger_id, source_credit_invoice_id, source_credit_payment_id) = 1))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.accounting_invoice_has_one_source'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='ck_whole_cents') IS DISTINCT FROM 'CHECK (created_at < ''2026-09-07 22:00:00+00''::timestamp with time zone OR net_amount = round(net_amount, 2) AND gross_amount = round(gross_amount, 2)) NOT VALID' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.ck_whole_cents'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_adjusts_invoice_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (adjusts_invoice_id) REFERENCES settlement_invoices(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_adjusts_invoice_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_club_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_club_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_from_entity_type_check') IS DISTINCT FROM 'CHECK (from_entity_type = ANY (ARRAY[''union''::text, ''club''::text, ''agent''::text, ''player''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_from_entity_type_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_invoice_type_check') IS DISTINCT FROM 'CHECK (invoice_type = ANY (ARRAY[''union_to_club''::text, ''club_to_agent''::text, ''agent_to_subagent''::text, ''agent_to_player''::text, ''union_club_pnl''::text, ''club_to_union''::text, ''union_weekly_squareup''::text, ''union_weekly_credit_note''::text, ''transaction_receipt''::text, ''club_weekly_accounting''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_invoice_type_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_period_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (period_id) REFERENCES settlement_periods(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_period_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_source_credit_invoice_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (source_credit_invoice_id) REFERENCES credit_invoices(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_source_credit_invoice_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_source_credit_invoice_id_key') IS DISTINCT FROM 'UNIQUE (source_credit_invoice_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_source_credit_invoice_id_key'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_source_credit_payment_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (source_credit_payment_id) REFERENCES credit_payments(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_source_credit_payment_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_source_credit_payment_id_key') IS DISTINCT FROM 'UNIQUE (source_credit_payment_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_source_credit_payment_id_key'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_source_ledger_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (source_ledger_id) REFERENCES chip_ledger(id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_source_ledger_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_source_ledger_id_key') IS DISTINCT FROM 'UNIQUE (source_ledger_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_source_ledger_id_key'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_status_check') IS DISTINCT FROM 'CHECK (status = ANY (ARRAY[''pending''::text, ''generated''::text, ''paid''::text, ''cancelled''::text, ''overdue''::text, ''disputed''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_status_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_invoices'::regclass AND conname='settlement_invoices_to_entity_type_check') IS DISTINCT FROM 'CHECK (to_entity_type = ANY (ARRAY[''club''::text, ''agent''::text, ''player''::text, ''union''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_invoices.settlement_invoices_to_entity_type_check'; END IF;
  IF pg_get_indexdef(to_regclass('public.accounting_one_club_weekly_statement')) IS DISTINCT FROM 'CREATE UNIQUE INDEX accounting_one_club_weekly_statement ON public.settlement_invoices USING btree (club_id, period_id) WHERE (invoice_type = ''club_weekly_accounting''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: accounting_one_club_weekly_statement'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_invoices_club_period')) IS DISTINCT FROM 'CREATE INDEX idx_invoices_club_period ON public.settlement_invoices USING btree (club_id, period_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_invoices_club_period'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_invoices_type')) IS DISTINCT FROM 'CREATE INDEX idx_invoices_type ON public.settlement_invoices USING btree (invoice_type, status)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_invoices_type'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_invoices_adjusts_idx')) IS DISTINCT FROM 'CREATE INDEX settlement_invoices_adjusts_idx ON public.settlement_invoices USING btree (adjusts_invoice_id) WHERE (adjusts_invoice_id IS NOT NULL)' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_invoices_adjusts_idx'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_invoices_due_open_idx')) IS DISTINCT FROM 'CREATE INDEX settlement_invoices_due_open_idx ON public.settlement_invoices USING btree (due_at) WHERE ((invoice_type = ''union_weekly_squareup''::text) AND (status = ANY (ARRAY[''generated''::text, ''overdue''::text])))' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_invoices_due_open_idx'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_invoices_number_uidx')) IS DISTINCT FROM 'CREATE UNIQUE INDEX settlement_invoices_number_uidx ON public.settlement_invoices USING btree (invoice_number) WHERE (invoice_number IS NOT NULL)' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_invoices_number_uidx'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_invoices_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX settlement_invoices_pkey ON public.settlement_invoices USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_invoices_pkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_invoices_source_credit_invoice_id_key')) IS DISTINCT FROM 'CREATE UNIQUE INDEX settlement_invoices_source_credit_invoice_id_key ON public.settlement_invoices USING btree (source_credit_invoice_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_invoices_source_credit_invoice_id_key'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_invoices_source_credit_payment_id_key')) IS DISTINCT FROM 'CREATE UNIQUE INDEX settlement_invoices_source_credit_payment_id_key ON public.settlement_invoices USING btree (source_credit_payment_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_invoices_source_credit_payment_id_key'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_invoices_source_ledger_id_key')) IS DISTINCT FROM 'CREATE UNIQUE INDEX settlement_invoices_source_ledger_id_key ON public.settlement_invoices USING btree (source_ledger_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_invoices_source_ledger_id_key'; END IF;
  IF pg_get_indexdef(to_regclass('public.uq_settlement_invoices_squareup')) IS DISTINCT FROM 'CREATE UNIQUE INDEX uq_settlement_invoices_squareup ON public.settlement_invoices USING btree (club_id, period_id, invoice_type) WHERE (invoice_type = ''union_weekly_squareup''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: uq_settlement_invoices_squareup'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.settlement_periods'::regclass AND tgname='trg_guard_retired_club_mutation') IS DISTINCT FROM 'CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON settlement_periods FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.settlement_periods'::regclass AND tgname='trg_guard_retired_club_mutation') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: settlement_periods.trg_guard_retired_club_mutation'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.settlement_periods'::regclass AND tgname='zz_closed_period_is_immutable') IS DISTINCT FROM 'CREATE TRIGGER zz_closed_period_is_immutable BEFORE DELETE OR UPDATE ON settlement_periods FOR EACH ROW EXECUTE FUNCTION zz_closed_period_is_immutable()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.settlement_periods'::regclass AND tgname='zz_closed_period_is_immutable') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: settlement_periods.zz_closed_period_is_immutable'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_periods'::regclass AND conname='settlement_periods_club_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_periods.settlement_periods_club_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_periods'::regclass AND conname='settlement_periods_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_periods.settlement_periods_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_periods'::regclass AND conname='settlement_periods_status_check') IS DISTINCT FROM 'CHECK (status = ANY (ARRAY[''open''::text, ''processing''::text, ''settled''::text, ''disputed''::text, ''closed''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_periods.settlement_periods_status_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.settlement_periods'::regclass AND conname='settlement_periods_union_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: settlement_periods.settlement_periods_union_id_fkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_settlement_periods_club')) IS DISTINCT FROM 'CREATE INDEX idx_settlement_periods_club ON public.settlement_periods USING btree (club_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_settlement_periods_club'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_periods_club_union_window_uidx')) IS DISTINCT FROM 'CREATE UNIQUE INDEX settlement_periods_club_union_window_uidx ON public.settlement_periods USING btree (club_id, union_id, start_at, end_at)' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_periods_club_union_window_uidx'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_periods_one_open_per_club_uidx')) IS DISTINCT FROM 'CREATE UNIQUE INDEX settlement_periods_one_open_per_club_uidx ON public.settlement_periods USING btree (COALESCE(club_id, ''00000000-0000-0000-0000-000000000000''::uuid)) WHERE (status = ''open''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_periods_one_open_per_club_uidx'; END IF;
  IF pg_get_indexdef(to_regclass('public.settlement_periods_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX settlement_periods_pkey ON public.settlement_periods USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: settlement_periods_pkey'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.social_conversation_participants'::regclass AND tgname='accounting_conversation_audience') IS DISTINCT FROM 'CREATE TRIGGER accounting_conversation_audience BEFORE INSERT OR DELETE OR UPDATE ON social_conversation_participants FOR EACH ROW EXECUTE FUNCTION fn_accounting_conversation_audience_guard()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.social_conversation_participants'::regclass AND tgname='accounting_conversation_audience') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: social_conversation_participants.accounting_conversation_audience'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_conversation_participants'::regclass AND conname='fk_social_conversation_participants_user_id_profiles') IS DISTINCT FROM 'FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_conversation_participants.fk_social_conversation_participants_user_id_profiles'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_conversation_participants'::regclass AND conname='social_conversation_participants_conversation_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (conversation_id) REFERENCES social_conversations(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_conversation_participants.social_conversation_participants_conversation_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_conversation_participants'::regclass AND conname='social_conversation_participants_conversation_id_user_id_key') IS DISTINCT FROM 'UNIQUE (conversation_id, user_id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_conversation_participants.social_conversation_participants_conversation_id_user_id_key'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_conversation_participants'::regclass AND conname='social_conversation_participants_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_conversation_participants.social_conversation_participants_pkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_scp_user_context')) IS DISTINCT FROM 'CREATE INDEX idx_scp_user_context ON public.social_conversation_participants USING btree (user_id, context_entity_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_scp_user_context'; END IF;
  IF pg_get_indexdef(to_regclass('public.social_conversation_participants_conversation_id_user_id_key')) IS DISTINCT FROM 'CREATE UNIQUE INDEX social_conversation_participants_conversation_id_user_id_key ON public.social_conversation_participants USING btree (conversation_id, user_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: social_conversation_participants_conversation_id_user_id_key'; END IF;
  IF pg_get_indexdef(to_regclass('public.social_conversation_participants_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX social_conversation_participants_pkey ON public.social_conversation_participants USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: social_conversation_participants_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_conversations'::regclass AND conname='social_conversations_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_conversations.social_conversations_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_conversations'::regclass AND conname='social_conversations_request_sender_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (request_sender_id) REFERENCES auth.users(id) ON DELETE SET NULL' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_conversations.social_conversations_request_sender_id_fkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_social_conversations_is_request')) IS DISTINCT FROM 'CREATE INDEX idx_social_conversations_is_request ON public.social_conversations USING btree (is_request) WHERE (is_request = true)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_social_conversations_is_request'; END IF;
  IF pg_get_indexdef(to_regclass('public.social_conversations_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX social_conversations_pkey ON public.social_conversations USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: social_conversations_pkey'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='accounting_discussion_observed') IS DISTINCT FROM 'CREATE TRIGGER accounting_discussion_observed AFTER INSERT ON social_messages FOR EACH ROW WHEN (COALESCE(new.message_type, ''text''::text) <> ALL (ARRAY[''invoice''::text, ''system''::text])) EXECUTE FUNCTION fn_accounting_discussion_observed()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='accounting_discussion_observed') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: social_messages.accounting_discussion_observed'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='accounting_message_immutable') IS DISTINCT FROM 'CREATE TRIGGER accounting_message_immutable BEFORE DELETE OR UPDATE ON social_messages FOR EACH ROW EXECUTE FUNCTION fn_accounting_document_immutable()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='accounting_message_immutable') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: social_messages.accounting_message_immutable'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='trg_block_message_field_reassignment') IS DISTINCT FROM 'CREATE TRIGGER trg_block_message_field_reassignment BEFORE UPDATE ON social_messages FOR EACH ROW EXECUTE FUNCTION fn_block_message_field_reassignment()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='trg_block_message_field_reassignment') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: social_messages.trg_block_message_field_reassignment'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='trg_live_invite_notification') IS DISTINCT FROM 'CREATE TRIGGER trg_live_invite_notification AFTER INSERT ON social_messages FOR EACH ROW EXECUTE FUNCTION trg_fn_live_invite_notification()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='trg_live_invite_notification') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: social_messages.trg_live_invite_notification'; END IF;
  IF (SELECT pg_get_triggerdef(oid,true) FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='trg_update_conversation_last_message') IS DISTINCT FROM 'CREATE TRIGGER trg_update_conversation_last_message AFTER INSERT ON social_messages FOR EACH ROW EXECUTE FUNCTION fn_update_conversation_last_message()' OR (SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.social_messages'::regclass AND tgname='trg_update_conversation_last_message') IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'Invoice trigger witness failed: social_messages.trg_update_conversation_last_message'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_messages'::regclass AND conname='fk_social_messages_sender_id_profiles') IS DISTINCT FROM 'FOREIGN KEY (sender_id) REFERENCES profiles(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_messages.fk_social_messages_sender_id_profiles'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_messages'::regclass AND conname='social_messages_conversation_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (conversation_id) REFERENCES social_conversations(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_messages.social_messages_conversation_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_messages'::regclass AND conname='social_messages_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_messages.social_messages_pkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_messages_conversation')) IS DISTINCT FROM 'CREATE INDEX idx_messages_conversation ON public.social_messages USING btree (conversation_id, created_at DESC)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_messages_conversation'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_social_messages_has_metadata')) IS DISTINCT FROM 'CREATE INDEX idx_social_messages_has_metadata ON public.social_messages USING btree (conversation_id, created_at) WHERE (media_metadata IS NOT NULL)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_social_messages_has_metadata'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_social_messages_sender_id')) IS DISTINCT FROM 'CREATE INDEX idx_social_messages_sender_id ON public.social_messages USING btree (sender_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_social_messages_sender_id'; END IF;
  IF pg_get_indexdef(to_regclass('public.social_messages_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX social_messages_pkey ON public.social_messages USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: social_messages_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_pages'::regclass AND conname='ck_home_group_link_is_home_game') IS DISTINCT FROM 'CHECK (linked_entity_type IS DISTINCT FROM ''home_group''::text OR page_type = ''home_game''::text)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_pages.ck_home_group_link_is_home_game'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_pages'::regclass AND conname='fk_social_pages_owner_id_profiles') IS DISTINCT FROM 'FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_pages.fk_social_pages_owner_id_profiles'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_pages'::regclass AND conname='fk_social_pages_owner_profile') IS DISTINCT FROM 'FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE SET NULL' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_pages.fk_social_pages_owner_profile'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_pages'::regclass AND conname='social_pages_owner_id_fkey') IS DISTINCT FROM 'FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_pages.social_pages_owner_id_fkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_pages'::regclass AND conname='social_pages_page_type_check') IS DISTINCT FROM 'CHECK (page_type = ANY (ARRAY[''venue''::text, ''group''::text, ''brand''::text, ''community''::text, ''club''::text, ''home_game''::text, ''charity''::text]))' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_pages.social_pages_page_type_check'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_pages'::regclass AND conname='social_pages_pkey') IS DISTINCT FROM 'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_pages.social_pages_pkey'; END IF;
  IF (SELECT pg_get_constraintdef(oid,true) FROM pg_constraint WHERE conrelid='public.social_pages'::regclass AND conname='social_pages_slug_key') IS DISTINCT FROM 'UNIQUE (slug)' THEN RAISE EXCEPTION 'Invoice constraint witness failed: social_pages.social_pages_slug_key'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_social_pages_home_games')) IS DISTINCT FROM 'CREATE INDEX idx_social_pages_home_games ON public.social_pages USING btree (page_type, is_public, location_state, location_city) WHERE (page_type = ''home_game''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_social_pages_home_games'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_social_pages_linked_entity')) IS DISTINCT FROM 'CREATE INDEX idx_social_pages_linked_entity ON public.social_pages USING btree (linked_entity_type, linked_entity_id) WHERE (linked_entity_type IS NOT NULL)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_social_pages_linked_entity'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_social_pages_linked_home_group')) IS DISTINCT FROM 'CREATE INDEX idx_social_pages_linked_home_group ON public.social_pages USING btree (linked_entity_id) WHERE (linked_entity_type = ''home_group''::text)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_social_pages_linked_home_group'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_social_pages_owner')) IS DISTINCT FROM 'CREATE INDEX idx_social_pages_owner ON public.social_pages USING btree (owner_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_social_pages_owner'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_social_pages_type')) IS DISTINCT FROM 'CREATE INDEX idx_social_pages_type ON public.social_pages USING btree (page_type)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_social_pages_type'; END IF;
  IF pg_get_indexdef(to_regclass('public.idx_social_pages_venue')) IS DISTINCT FROM 'CREATE INDEX idx_social_pages_venue ON public.social_pages USING btree (linked_venue_id)' THEN RAISE EXCEPTION 'Invoice index witness failed: idx_social_pages_venue'; END IF;
  IF pg_get_indexdef(to_regclass('public.social_pages_pkey')) IS DISTINCT FROM 'CREATE UNIQUE INDEX social_pages_pkey ON public.social_pages USING btree (id)' THEN RAISE EXCEPTION 'Invoice index witness failed: social_pages_pkey'; END IF;
  IF pg_get_indexdef(to_regclass('public.social_pages_slug_key')) IS DISTINCT FROM 'CREATE UNIQUE INDEX social_pages_slug_key ON public.social_pages USING btree (slug)' THEN RAISE EXCEPTION 'Invoice index witness failed: social_pages_slug_key'; END IF;
END $invoice_catalog_witness$;

RESET search_path;
