-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815165713 "backfill_youtube_posters_for_posterless_posts"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c5d904fca80365bc8ae9dd9401a9c136 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Second half of the feed poster backfill.
--
-- 9,524 video posts had NO poster at all (blank tile in the feed). 9,523 of
-- them carry a YouTube URL in media_urls[0] rather than original_media_url,
-- so the first backfill did not reach them.
--
-- 286 distinct video ids back those posts. Each was probed directly for a
-- real maxresdefault.jpg: 148 return 1280x720, 138 return 404 (a large share
-- of the 404s are patterned ids that look like seeded test data and are
-- probably not real YouTube videos at all). Only the 148 CONFIRMED ids are
-- written here — the rest keep their current state, which is no worse than
-- before. No guessing: every id in the list below was fetched and its JPEG
-- SOF header parsed.

WITH target AS (
    SELECT id,
           thumbnail_url,
           substring((media_urls->>0) from '(?:embed/|watch\?v=|youtu\.be/|/vi/)([A-Za-z0-9_-]{11})') AS vid
      FROM public.social_posts
     WHERE content_type = 'video'
       AND (is_deleted IS NULL OR is_deleted = false)
       AND (thumbnail_url IS NULL OR thumbnail_url = '')
       AND ((media_urls->>0) ILIKE '%youtube%' OR (media_urls->>0) ILIKE '%youtu.be%')
)
INSERT INTO public.social_posts_thumbnail_backup_20260815 (post_id, old_thumbnail_url)
SELECT id, thumbnail_url FROM target
 WHERE vid IS NOT NULL
   AND vid IN ('__jU-p7PrrU','-dXBX-iUw0Q','-3F5MA8AvYs','_l-ndw-CDG4','-Juex_1oYus','1I8bbDENedI','-ZVAdAydyU0','2KjPKwgycOQ','-rjQT0JOhGA','_XaTQVqkIBw','_LzFC20Olis','0JKcmKgGvgk','0G9SseSG9mo','185vMNh9ECc','0Wi3PwubKs4','0FK4cqOMrJ8','2aaQ8D5mQiQ','3fXVU1dbK7U','46ayQpwVzFI','4ErqhJMdTqE','4Q8tyshPqto','3QGcW70nKAo','524_3UypGkU','4kkx1r3YaAU','4441ee7htt0','5wTToeCyu6I','6I10JPRg-XM','Aefg8dqdtLI','87jKEQA-wp8','9ucgJSjFZc4','9ZjGeSFzCgE','atBp1P2-IqQ','6vyO89eugpA','aPbTyE-LsQk','7i3fqwd6KsI','6pS_AFMY6WY','AhfeoNu7EnA','ADVw3c91-NI','9RMgHjToDFw','bjSK8Ajhm2g','biOHrFZevB8','B90Y2efQHYA','bEmvJ8i_2oY','cWmZlg3Uhog','cmuvpO-vSb8','CbXDixknmeM','CwXfzhYSayI','Cq75gEVn5F8','DGPqtqInt6c','Dhlr255j55o','Dwv4ekxyS3A','DPlxVhu8wVA','D5R_ZQZDR1Q','dNbp--c1Y5M','eECONEqQBJk','eajgQEhEBuM','fhgYiIyxtSE','FGytzJRnXsg','Fy6I9DmPrmA','fzNt4SdBGuQ','fwr4hulh-Y0','G4oVJGOXQGg','fy8Y3mg_ikA','gkLoIe5J45g','fif_M-C7uxM','GcfgcuyVugA','gqH0Og9Z--k','Fx3TLCUpRNc','Gqoeoy1MIZ8','h1YsGpdcf7Y','HB__atwkWpE','hbUUGtnAA5Q','HNJAz1EuPnk','hpcKG_xl16c','I1H29pmSc1g','ikVoJHSH1SE','IVGRM1OF-oo','JgxFJJ7FLNE','JIpyN-o7Gsc','kCfNqGeHWpM','JPA4I5arlG0','k9LoVaVbsKg','KuTzb8Am_DI','lD4xok14Dig','KQRZs6ytdWc','L85WOvR7Pqs','M-10B7u4Sy4','LsKAD03JFBI','LA4z0Hi0Jf8','N-gvOm-5hAc','NKFFVY6Q37s','N6S1UlkMLN8','m0qxj0FNag4','nA3klZ8Oy1M','oi7asK5aoiw','o6ZSSql1in0','P5Ju7eb4uXs','oINUSqHq_ck','oW3Dhzt0m68','PalPSvIIxUg','pFbHkHhJO4Y','obkeMpIYOqY','PTv3nBvWPCI','qbVkC0sUTlY','QiEBN6H0a-g','Q6RjPaXyRhY','qeItZFws2Hk','RbYq6UeUMdY','R01rPUaJU1I','RGQGKUmFEdo','rc8bOm2uZ0g','qMkzvbIccq0','rSQpzr24-fY','RTvaz9x7ER0','tHwgfIDLsSA','rAHFyM3ve2c','RuuJsLyQJNY','Tvt3ib08foo','TKuwraMHM4s','u4TitTh2SYc','UToy9DFnl-8','tOSzCNYe-e8','uEwzQFhCdps','UNDaUcrBGPY','uvCjBlQXupw','uYVmCE6meLI','UjZO25s0lpk','TZgK5LNp_HQ','VknSBaSAX2I','WcwJL2TAqnM','vXBrOA-AHKY','W4kTojh1WGo','Wp5G4CDS2Tk','VqnW-BqOrLM','Wo1mGd8_XXE','XhKuETc1460','x_r9TpwhGaw','xIeM6KCrIE4','TXarmUgk02Q','yJZxw9u7_DU','y5wfGQLUiQo','yIZcxafGzXQ','Ykbx5yv6xzA','yRJMtgIK9C8','Z2SNlxN1mBU','ZRSfWVI950c','YqOR1jy_TSc','yyj2qZwCq2A')
ON CONFLICT (post_id) DO NOTHING;

WITH target AS (
    SELECT id,
           substring((media_urls->>0) from '(?:embed/|watch\?v=|youtu\.be/|/vi/)([A-Za-z0-9_-]{11})') AS vid
      FROM public.social_posts
     WHERE content_type = 'video'
       AND (is_deleted IS NULL OR is_deleted = false)
       AND (thumbnail_url IS NULL OR thumbnail_url = '')
       AND ((media_urls->>0) ILIKE '%youtube%' OR (media_urls->>0) ILIKE '%youtu.be%')
)
UPDATE public.social_posts p
   SET thumbnail_url = 'https://img.youtube.com/vi/' || t.vid || '/maxresdefault.jpg'
  FROM target t
 WHERE p.id = t.id
   AND t.vid IS NOT NULL
   AND t.vid IN ('__jU-p7PrrU','-dXBX-iUw0Q','-3F5MA8AvYs','_l-ndw-CDG4','-Juex_1oYus','1I8bbDENedI','-ZVAdAydyU0','2KjPKwgycOQ','-rjQT0JOhGA','_XaTQVqkIBw','_LzFC20Olis','0JKcmKgGvgk','0G9SseSG9mo','185vMNh9ECc','0Wi3PwubKs4','0FK4cqOMrJ8','2aaQ8D5mQiQ','3fXVU1dbK7U','46ayQpwVzFI','4ErqhJMdTqE','4Q8tyshPqto','3QGcW70nKAo','524_3UypGkU','4kkx1r3YaAU','4441ee7htt0','5wTToeCyu6I','6I10JPRg-XM','Aefg8dqdtLI','87jKEQA-wp8','9ucgJSjFZc4','9ZjGeSFzCgE','atBp1P2-IqQ','6vyO89eugpA','aPbTyE-LsQk','7i3fqwd6KsI','6pS_AFMY6WY','AhfeoNu7EnA','ADVw3c91-NI','9RMgHjToDFw','bjSK8Ajhm2g','biOHrFZevB8','B90Y2efQHYA','bEmvJ8i_2oY','cWmZlg3Uhog','cmuvpO-vSb8','CbXDixknmeM','CwXfzhYSayI','Cq75gEVn5F8','DGPqtqInt6c','Dhlr255j55o','Dwv4ekxyS3A','DPlxVhu8wVA','D5R_ZQZDR1Q','dNbp--c1Y5M','eECONEqQBJk','eajgQEhEBuM','fhgYiIyxtSE','FGytzJRnXsg','Fy6I9DmPrmA','fzNt4SdBGuQ','fwr4hulh-Y0','G4oVJGOXQGg','fy8Y3mg_ikA','gkLoIe5J45g','fif_M-C7uxM','GcfgcuyVugA','gqH0Og9Z--k','Fx3TLCUpRNc','Gqoeoy1MIZ8','h1YsGpdcf7Y','HB__atwkWpE','hbUUGtnAA5Q','HNJAz1EuPnk','hpcKG_xl16c','I1H29pmSc1g','ikVoJHSH1SE','IVGRM1OF-oo','JgxFJJ7FLNE','JIpyN-o7Gsc','kCfNqGeHWpM','JPA4I5arlG0','k9LoVaVbsKg','KuTzb8Am_DI','lD4xok14Dig','KQRZs6ytdWc','L85WOvR7Pqs','M-10B7u4Sy4','LsKAD03JFBI','LA4z0Hi0Jf8','N-gvOm-5hAc','NKFFVY6Q37s','N6S1UlkMLN8','m0qxj0FNag4','nA3klZ8Oy1M','oi7asK5aoiw','o6ZSSql1in0','P5Ju7eb4uXs','oINUSqHq_ck','oW3Dhzt0m68','PalPSvIIxUg','pFbHkHhJO4Y','obkeMpIYOqY','PTv3nBvWPCI','qbVkC0sUTlY','QiEBN6H0a-g','Q6RjPaXyRhY','qeItZFws2Hk','RbYq6UeUMdY','R01rPUaJU1I','RGQGKUmFEdo','rc8bOm2uZ0g','qMkzvbIccq0','rSQpzr24-fY','RTvaz9x7ER0','tHwgfIDLsSA','rAHFyM3ve2c','RuuJsLyQJNY','Tvt3ib08foo','TKuwraMHM4s','u4TitTh2SYc','UToy9DFnl-8','tOSzCNYe-e8','uEwzQFhCdps','UNDaUcrBGPY','uvCjBlQXupw','uYVmCE6meLI','UjZO25s0lpk','TZgK5LNp_HQ','VknSBaSAX2I','WcwJL2TAqnM','vXBrOA-AHKY','W4kTojh1WGo','Wp5G4CDS2Tk','VqnW-BqOrLM','Wo1mGd8_XXE','XhKuETc1460','x_r9TpwhGaw','xIeM6KCrIE4','TXarmUgk02Q','yJZxw9u7_DU','y5wfGQLUiQo','yIZcxafGzXQ','Ykbx5yv6xzA','yRJMtgIK9C8','Z2SNlxN1mBU','ZRSfWVI950c','YqOR1jy_TSc','yyj2qZwCq2A');

DO $$
DECLARE
    v_maxres int;
    v_none int;
BEGIN
    SELECT COUNT(*) FILTER (WHERE thumbnail_url ILIKE '%maxresdefault%'),
           COUNT(*) FILTER (WHERE thumbnail_url IS NULL OR thumbnail_url = '')
      INTO v_maxres, v_none
      FROM public.social_posts
     WHERE content_type = 'video' AND (is_deleted IS NULL OR is_deleted = false);

    RAISE NOTICE 'video posts on a 1280x720 poster: %; still posterless: %', v_maxres, v_none;

    IF v_maxres < 6466 THEN
        RAISE EXCEPTION 'poster count went backwards (%), expected at least 6466', v_maxres;
    END IF;
END $$;
