-- Migration to add audio_url to messages table for the new VoiceRecorder feature
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS audio_url text;

-- Add index if missing but useful for lookups, though rarely searched by audio_url alone
-- CREATE INDEX IF NOT EXISTS idx_messages_audio_url ON public.messages(audio_url) WHERE audio_url IS NOT NULL;
