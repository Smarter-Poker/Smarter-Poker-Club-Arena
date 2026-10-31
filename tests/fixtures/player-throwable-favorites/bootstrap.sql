CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE TABLE public.throw_usage(id bigint GENERATED ALWAYS AS IDENTITY, user_id uuid, throwable_id text);
INSERT INTO public.throw_usage(user_id, throwable_id)
SELECT '00000000-0000-0000-0000-000000000001', 'tomato' FROM generate_series(1,3);
INSERT INTO public.throw_usage(user_id, throwable_id)
SELECT '00000000-0000-0000-0000-000000000002', 'heart' FROM generate_series(1,20);
INSERT INTO public.throw_usage(user_id, throwable_id)
SELECT '00000000-0000-0000-0000-000000000002', 'bomb' FROM generate_series(1,10);
INSERT INTO public.throw_usage(user_id, throwable_id)
SELECT '00000000-0000-0000-0000-000000000002', 'retired_item' FROM generate_series(1,100);
