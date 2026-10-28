CREATE TABLE public.ca_stat_distribution(cohort text,metric text,p10 numeric,p25 numeric,p50 numeric,
 p75 numeric,p90 numeric,sample_size integer,computed_at timestamptz,PRIMARY KEY(cohort,metric));
