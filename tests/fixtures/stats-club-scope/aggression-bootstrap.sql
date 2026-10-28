ALTER TABLE public.hand_history ADD COLUMN actions jsonb;
ALTER TABLE public.hand_history ADD COLUMN big_blind numeric DEFAULT 2;
