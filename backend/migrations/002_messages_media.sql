ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_url TEXT;

UPDATE messages
SET message_type = 'text'
WHERE message_type IS NULL OR message_type = '';
