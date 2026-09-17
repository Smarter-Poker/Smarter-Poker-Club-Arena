-- Disposable Diamond bank payout fixture only; never a production migration.
-- Exact read-only catalog source and scope: schema-provenance.json.


SET search_path=public,extensions;

CREATE TABLE public."accounting_conversations" (
  "scope_id" uuid NOT NULL,
  "issuer_type" text COLLATE "default" NOT NULL,
  "issuer_id" uuid NOT NULL,
  "sender_id" uuid NOT NULL,
  "recipient_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "last_discussion_at" timestamp with time zone
);

ALTER TABLE public."accounting_conversations" OWNER TO "postgres";

CREATE TABLE public."accounting_invoice_counters" (
  "year" integer NOT NULL,
  "next_number" bigint NOT NULL
);

ALTER TABLE public."accounting_invoice_counters" OWNER TO "postgres";

CREATE TABLE public."accounting_invoice_deliveries" (
  "invoice_id" uuid NOT NULL,
  "recipient_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "notification_id" uuid NOT NULL,
  "delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivery_mode" text COLLATE "default" DEFAULT 'immediate'::text NOT NULL
);

ALTER TABLE public."accounting_invoice_deliveries" OWNER TO "postgres";

CREATE TABLE public."agents" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "club_id" uuid NOT NULL,
  "membership_id" uuid,
  "role" text COLLATE "default" NOT NULL,
  "status" text COLLATE "default" DEFAULT 'active'::text NOT NULL,
  "parent_agent_id" uuid,
  "commission_rate" numeric(5,4) NOT NULL,
  "player_rakeback_rate" numeric(5,4) NOT NULL,
  "credit_limit" numeric(15,2) DEFAULT 0 NOT NULL,
  "credit_used" numeric(15,2) DEFAULT 0 NOT NULL,
  "is_prepaid" boolean DEFAULT false NOT NULL,
  "business_balance" numeric(15,2) DEFAULT 0 NOT NULL,
  "player_balance" numeric(15,2) DEFAULT 0 NOT NULL,
  "promo_balance" numeric(15,2) DEFAULT 0 NOT NULL,
  "total_players" integer DEFAULT 0 NOT NULL,
  "active_player_count" integer DEFAULT 0 NOT NULL,
  "sub_agent_count" integer DEFAULT 0 NOT NULL,
  "weekly_rake_generated" numeric(15,2) DEFAULT 0 NOT NULL,
  "lifetime_earnings" numeric(15,2) DEFAULT 0 NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_active_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "auto_rakeback_enabled" boolean DEFAULT true,
  "rakeback_percentage" numeric(5,4) DEFAULT 0.0000,
  "agent_wallet_balance" numeric(18,2) DEFAULT 0,
  "player_wallet_balance" numeric(18,4) DEFAULT 0,
  "promo_wallet_balance" numeric(18,2) DEFAULT 0,
  "lifetime_rake_generated" numeric(18,4) DEFAULT 0
);

ALTER TABLE public."agents" OWNER TO "postgres";

CREATE TABLE public."credit_invoices" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "debt_owed" numeric DEFAULT 0 NOT NULL,
  "amount_paid" numeric DEFAULT 0 NOT NULL,
  "amount_remaining" numeric DEFAULT 0 NOT NULL,
  "status" text COLLATE "default" DEFAULT 'pending'::text NOT NULL,
  "due_date" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_at" timestamp with time zone,
  "void_reason" text COLLATE "default"
);

ALTER TABLE public."credit_invoices" OWNER TO "postgres";

CREATE TABLE public."credit_payments" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "invoice_id" uuid NOT NULL,
  "amount" numeric NOT NULL,
  "payment_method" text COLLATE "default" NOT NULL,
  "transaction_id" text COLLATE "default",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "operation_id" uuid,
  "payer_user_id" uuid,
  "payment_reference" text COLLATE "default"
);

ALTER TABLE public."credit_payments" OWNER TO "postgres";

CREATE TABLE public."notifications" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "type" text COLLATE "default" NOT NULL,
  "title" text COLLATE "default" NOT NULL,
  "message" text COLLATE "default",
  "data" jsonb DEFAULT '{}'::jsonb,
  "read" boolean DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "is_read" boolean DEFAULT false,
  "action_url" text COLLATE "default",
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "actor_id" uuid,
  "link" text COLLATE "default",
  "read_at" timestamp with time zone
);

ALTER TABLE public."notifications" OWNER TO "postgres";

CREATE TABLE public."push_outbox" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "recipient_user_id" uuid,
  "title" text COLLATE "default" NOT NULL,
  "body" text COLLATE "default" NOT NULL,
  "url" text COLLATE "default",
  "icon_url" text COLLATE "default",
  "badge_url" text COLLATE "default",
  "tag" text COLLATE "default",
  "status" text COLLATE "default" DEFAULT 'pending'::text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "failure_reason" text COLLATE "default",
  "related_entity_id" uuid,
  "event" text COLLATE "default",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "image_url" text COLLATE "default",
  "accounting_notification_id" uuid,
  "next_attempt_at" timestamp with time zone
);

ALTER TABLE public."push_outbox" OWNER TO "postgres";

CREATE TABLE public."settlement_invoices" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "club_id" uuid NOT NULL,
  "period_id" uuid,
  "invoice_type" text COLLATE "default" NOT NULL,
  "from_entity_type" text COLLATE "default" NOT NULL,
  "from_entity_id" text COLLATE "default" NOT NULL,
  "to_entity_type" text COLLATE "default" NOT NULL,
  "to_entity_id" text COLLATE "default" NOT NULL,
  "gross_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "net_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "deductions" numeric(12,2) DEFAULT 0 NOT NULL,
  "breakdown" jsonb DEFAULT '{}'::jsonb,
  "status" text COLLATE "default" DEFAULT 'generated'::text NOT NULL,
  "chip_transfer_id" uuid,
  "chips_transferred" boolean DEFAULT false,
  "transferred_at" timestamp with time zone,
  "message_sent" boolean DEFAULT false,
  "message_sent_at" timestamp with time zone,
  "notes" text COLLATE "default",
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "due_at" timestamp with time zone,
  "invoice_number" text COLLATE "default",
  "adjusts_invoice_id" uuid,
  "overdue_at" timestamp with time zone,
  "reminders_sent" integer DEFAULT 0 NOT NULL,
  "last_reminder_at" timestamp with time zone,
  "source_ledger_id" uuid,
  "source_credit_invoice_id" uuid,
  "source_credit_payment_id" uuid
);

ALTER TABLE public."settlement_invoices" OWNER TO "postgres";

CREATE TABLE public."settlement_periods" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "club_id" uuid,
  "union_id" uuid,
  "period_number" integer NOT NULL,
  "year" integer NOT NULL,
  "start_at" timestamp with time zone NOT NULL,
  "end_at" timestamp with time zone NOT NULL,
  "status" text COLLATE "default" DEFAULT 'open'::text,
  "total_rake_collected" numeric(15,2) DEFAULT 0,
  "total_bbj_contributions" numeric(15,2) DEFAULT 0,
  "total_player_winnings" numeric(15,2) DEFAULT 0,
  "total_player_losses" numeric(15,2) DEFAULT 0,
  "total_hands_dealt" integer DEFAULT 0,
  "settled_at" timestamp with time zone,
  "settled_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "total_commissions_paid" numeric(12,2) DEFAULT 0,
  "notes" text COLLATE "default",
  "seated_stack_snapshot" numeric
);

ALTER TABLE public."settlement_periods" OWNER TO "postgres";

CREATE TABLE public."social_conversation_participants" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid,
  "user_id" uuid,
  "joined_at" timestamp with time zone DEFAULT now(),
  "last_read_at" timestamp with time zone,
  "is_muted" boolean DEFAULT false,
  "read_receipts_enabled" boolean DEFAULT true,
  "is_pinned" boolean DEFAULT false,
  "context_entity_id" uuid,
  "context_entity_type" text COLLATE "default"
);

ALTER TABLE public."social_conversation_participants" OWNER TO "postgres";

CREATE TABLE public."social_conversations" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "last_message_at" timestamp with time zone DEFAULT now(),
  "last_message_preview" text COLLATE "default",
  "is_group" boolean DEFAULT false,
  "group_name" text COLLATE "default",
  "is_request" boolean DEFAULT false,
  "request_sender_id" uuid,
  "context_entity_id" uuid,
  "context_entity_type" text COLLATE "default"
);

ALTER TABLE public."social_conversations" OWNER TO "postgres";

CREATE TABLE public."social_messages" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid,
  "sender_id" uuid,
  "content" text COLLATE "default" NOT NULL,
  "message_type" text COLLATE "default" DEFAULT 'text'::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "is_edited" boolean DEFAULT false,
  "is_deleted" boolean DEFAULT false,
  "read_at" timestamp with time zone,
  "media_metadata" jsonb
);

ALTER TABLE public."social_messages" OWNER TO "postgres";

CREATE TABLE public."social_pages" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid,
  "page_type" text COLLATE "default" NOT NULL,
  "name" text COLLATE "default" NOT NULL,
  "slug" text COLLATE "default",
  "description" text COLLATE "default",
  "avatar_url" text COLLATE "default",
  "cover_url" text COLLATE "default",
  "category" text COLLATE "default" DEFAULT 'general'::text,
  "website" text COLLATE "default",
  "contact_email" text COLLATE "default",
  "phone" text COLLATE "default",
  "location_city" text COLLATE "default",
  "location_state" text COLLATE "default",
  "location_country" text COLLATE "default" DEFAULT 'US'::text,
  "linked_venue_id" text COLLATE "default",
  "linked_entity_type" text COLLATE "default",
  "linked_entity_id" text COLLATE "default",
  "follower_count" integer DEFAULT 0,
  "post_count" integer DEFAULT 0,
  "member_count" integer DEFAULT 0,
  "is_verified" boolean DEFAULT false,
  "is_public" boolean DEFAULT true,
  "allow_member_posts" boolean DEFAULT true,
  "require_post_approval" boolean DEFAULT false,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "view_count" integer DEFAULT 0,
  "avg_rating" numeric(3,2) DEFAULT 0
);

ALTER TABLE public."social_pages" OWNER TO "postgres";

RESET search_path;
