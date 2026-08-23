CREATE OR REPLACE FUNCTION public.get_func_source(fn_name text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT prosrc FROM pg_proc WHERE proname = fn_name LIMIT 1;
$$;
