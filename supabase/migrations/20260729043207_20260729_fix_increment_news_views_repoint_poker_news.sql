-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260729043207 "20260729_fix_increment_news_views_repoint_poker_news"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 576b29a1ca4929debb029017c20f46ba of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Content-pipeline audit fix (2026-07-29): increment_news_views was repointed at
-- some point to news_articles (0 rows) with a blanket EXCEPTION...NULL swallow, so
-- every news view silently updated nothing and poker_news view counts froze. The
-- real content table is poker_news (2,559 rows). Repoint to poker_news and keep
-- both count columns (views + view_count) in sync, since reels/videos ordering
-- reads view_count while the original articles counter used views.
CREATE OR REPLACE FUNCTION public.increment_news_views(news_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  UPDATE public.poker_news
     SET views      = COALESCE(views, 0) + 1,
         view_count = COALESCE(view_count, 0) + 1
   WHERE id = news_id;
END;
$function$;
