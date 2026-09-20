CREATE TABLE public.accounting_period_recompute_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 club_id uuid NOT NULL REFERENCES public.clubs(id),
 period_start date NOT NULL,
 period_end date NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','blocked','complete')),
 reason text,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 attempted_at timestamptz,
 attempts bigint NOT NULL DEFAULT 0,
 last_result jsonb NOT NULL DEFAULT '{}',
 UNIQUE(club_id,period_start,period_end),
 CHECK(extract(isodow FROM period_start)=1 AND period_end=period_start+6)
);
ALTER TABLE public.accounting_period_recompute_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_period_recompute_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_period_recompute_requests TO service_role;
CREATE INDEX accounting_period_recompute_requests_pending ON public.accounting_period_recompute_requests(period_start,club_id) WHERE status<>'complete';


CREATE TABLE rakeback_stats_applied(rake_record_id uuid,user_id uuid,hands int,rake numeric,PRIMARY KEY(rake_record_id,user_id));
CREATE TABLE player_stats(user_id uuid,club_id uuid,hands_played int,total_rake numeric,total_winnings numeric,total_losses numeric,vpip numeric,pfr numeric,tournaments_played int,tournaments_won int,updated_at timestamptz,PRIMARY KEY(user_id,club_id));
CREATE FUNCTION test_cash_stats_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF current_setting('test.fail_stats',true)='true' THEN RAISE EXCEPTION 'stats unavailable'; END IF; RETURN NEW;END$$;
CREATE TRIGGER test_cash_stats_failure BEFORE INSERT ON player_stats FOR EACH ROW EXECUTE FUNCTION test_cash_stats_failure();
CREATE FUNCTION test_cash_queue_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF current_setting('test.fail_queue',true)='true' THEN RAISE EXCEPTION 'period queue unavailable'; END IF; RETURN NEW;END$$;
CREATE TRIGGER test_cash_queue_failure BEFORE INSERT ON accounting_period_recompute_requests FOR EACH ROW EXECUTE FUNCTION test_cash_queue_failure();

CREATE FUNCTION test_cash_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF current_setting('test.fail_ack',true)='true' AND NEW.status='accrued' THEN RAISE EXCEPTION 'ack receipt unavailable'; END IF; RETURN NEW;END$$;
CREATE FUNCTION test_cash_work_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF current_setting('test.fail_work',true)='true' AND NEW.status='accrued' THEN RAISE EXCEPTION 'retry work unavailable'; END IF; RETURN NEW;END$$;
