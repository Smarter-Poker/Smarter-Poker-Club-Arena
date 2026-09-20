-- SOURCE ONLY / UNRUN. Loaded inside the eventual single guarded transaction.
-- No standalone activation. Root document/delivery/reader fragments are required.
ALTER TABLE public.agents ADD COLUMN credit_control_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE public.agents ADD CONSTRAINT agents_credit_control_revision_nonnegative
 CHECK(credit_control_revision>=0);

CREATE FUNCTION public.fn_agent_credit_control_revision_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.credit_control_revision IS DISTINCT FROM 0 THEN
   RAISE EXCEPTION 'credit_control_revision_is_managed' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NEW.credit_control_revision IS DISTINCT FROM OLD.credit_control_revision THEN
  RAISE EXCEPTION 'credit_control_revision_is_managed' USING ERRCODE='23514';END IF;
 IF ROW(NEW.club_id,NEW.user_id,NEW.credit_limit,NEW.credit_used,NEW.is_prepaid,NEW.status,NEW.role,NEW.parent_agent_id)
    IS DISTINCT FROM ROW(OLD.club_id,OLD.user_id,OLD.credit_limit,OLD.credit_used,OLD.is_prepaid,OLD.status,OLD.role,OLD.parent_agent_id) THEN
  IF OLD.credit_control_revision=9223372036854775807 THEN
   RAISE EXCEPTION 'credit_control_revision_exhausted' USING ERRCODE='22003';END IF;
  NEW.credit_control_revision:=OLD.credit_control_revision+1;
 END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_agent_credit_control_revision_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_agent_credit_control_revision_v1() FROM PUBLIC,anon,authenticated,service_role;
-- Last among the guarded current BEFORE triggers, after agreement validation.
-- Adds no advisory lock to existing financial writers' row-lock paths.
CREATE TRIGGER zzzz_credit_control_revision_v1 BEFORE INSERT OR UPDATE ON public.agents
 FOR EACH ROW EXECUTE FUNCTION public.fn_agent_credit_control_revision_v1();

CREATE TABLE public.accounting_credit_reduction_operations_v1(
 id uuid PRIMARY KEY,contract_version smallint NOT NULL CHECK(contract_version=1),
 actor_user_id uuid NOT NULL,operation_id uuid NOT NULL,club_id uuid NOT NULL,
 agent_id uuid NOT NULL,target_user_id uuid NOT NULL,
 action text NOT NULL CHECK(action='reduce_credit_limit'),
 requested_reduction numeric(15,2) NOT NULL CHECK(requested_reduction>0 AND requested_reduction<=1000000000),
 reason text,assignment_reason text NOT NULL,
 before_limit numeric(15,2) NOT NULL,after_limit numeric(15,2) NOT NULL,
 credit_used numeric(15,2) NOT NULL,before_prepaid boolean NOT NULL,after_prepaid boolean NOT NULL,
 before_revision bigint NOT NULL CHECK(before_revision>=0),after_revision bigint NOT NULL CHECK(after_revision>=0),
 applied_reduction numeric(15,2) NOT NULL,
 assignment_id uuid,document_id uuid,invoice_id uuid,
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 UNIQUE(actor_user_id,operation_id),UNIQUE(assignment_id),UNIQUE(document_id),UNIQUE(invoice_id),
 CHECK(NOT ('00000000-0000-0000-0000-000000000000'::uuid=ANY(ARRAY[id,actor_user_id,operation_id,club_id,agent_id,target_user_id]))),
 CHECK(assignment_id IS NULL OR assignment_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 CHECK(document_id IS NULL OR document_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 CHECK(invoice_id IS NULL OR invoice_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 CHECK(before_limit::text NOT IN('NaN','Infinity','-Infinity') AND before_limit>=0),
 CHECK(after_limit::text NOT IN('NaN','Infinity','-Infinity') AND after_limit>=0),
 CHECK(credit_used::text NOT IN('NaN','Infinity','-Infinity') AND credit_used>=0),
 CHECK(applied_reduction::text NOT IN('NaN','Infinity','-Infinity') AND applied_reduction>=0),
 CHECK(applied_reduction=least(requested_reduction,before_limit) AND after_limit=before_limit-applied_reduction),
 CHECK(assignment_reason=CASE WHEN reason IS NULL OR reason='' THEN 'Credit line reduced' ELSE reason END),
 CHECK((applied_reduction>0 AND NOT before_prepaid AND before_limit>0 AND credit_used<=after_limit
         AND after_prepaid=(after_limit=0) AND after_revision::numeric=before_revision::numeric+1
         AND assignment_id IS NOT NULL AND document_id IS NOT NULL AND invoice_id IS NOT NULL
         AND assignment_id<>document_id AND assignment_id<>invoice_id AND document_id<>invoice_id)
    OR (applied_reduction=0 AND before_limit=0 AND after_limit=0 AND credit_used=0
         AND before_prepaid AND after_prepaid AND before_revision=after_revision
         AND assignment_id IS NULL AND document_id IS NULL AND invoice_id IS NULL))
);
ALTER TABLE public.accounting_credit_reduction_operations_v1 OWNER TO postgres;
ALTER TABLE public.accounting_credit_reduction_operations_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_credit_reduction_operations_v1 FROM PUBLIC,anon,authenticated,service_role;

-- An identity-only cancellation fence, never fabricated original financial intent.
-- No FK to current user/club/agent/audit rows: historical receipts survive deletion.
CREATE TABLE public.accounting_credit_reduction_retirements_v1(
 id uuid PRIMARY KEY,contract_version smallint NOT NULL CHECK(contract_version=1),
 actor_user_id uuid NOT NULL,operation_id uuid NOT NULL,club_id uuid NOT NULL,
 retired_at timestamptz NOT NULL CHECK(isfinite(retired_at)),
 UNIQUE(actor_user_id,operation_id),
 CHECK(NOT ('00000000-0000-0000-0000-000000000000'::uuid=ANY(ARRAY[id,actor_user_id,operation_id,club_id])))
);
ALTER TABLE public.accounting_credit_reduction_retirements_v1 OWNER TO postgres;
ALTER TABLE public.accounting_credit_reduction_retirements_v1 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_credit_reduction_retirements_v1 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_credit_reduction_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'credit_reduction_evidence_is_immutable' USING ERRCODE='23514';END $function$;
ALTER FUNCTION public.fn_credit_reduction_immutable_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_credit_reduction_immutable_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER credit_reduction_operation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.accounting_credit_reduction_operations_v1 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_credit_reduction_immutable_v1();
CREATE TRIGGER credit_reduction_retirement_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
 ON public.accounting_credit_reduction_retirements_v1 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_credit_reduction_immutable_v1();

-- Keep the final transaction state exclusive even if a later nested trigger
-- attempts to add the opposite terminal record after the wrapper's readback.
CREATE FUNCTION public.fn_credit_reduction_terminal_exclusive_v1() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM public.accounting_credit_reduction_operations_v1 o
   JOIN public.accounting_credit_reduction_retirements_v1 r
    ON r.actor_user_id=o.actor_user_id AND r.operation_id=o.operation_id
   WHERE o.actor_user_id=NEW.actor_user_id AND o.operation_id=NEW.operation_id) THEN
  RAISE EXCEPTION 'credit_reduction_evidence_conflict' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_credit_reduction_terminal_exclusive_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_credit_reduction_terminal_exclusive_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER credit_reduction_operation_exclusive_v1 AFTER INSERT
 ON public.accounting_credit_reduction_operations_v1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.fn_credit_reduction_terminal_exclusive_v1();
CREATE CONSTRAINT TRIGGER credit_reduction_retirement_exclusive_v1 AFTER INSERT
 ON public.accounting_credit_reduction_retirements_v1 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 EXECUTE FUNCTION public.fn_credit_reduction_terminal_exclusive_v1();
