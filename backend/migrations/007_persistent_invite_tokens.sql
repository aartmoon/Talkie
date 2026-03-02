ALTER TABLE room_invite_links
  ADD COLUMN IF NOT EXISTS token TEXT;

ALTER TABLE friend_invite_links
  ADD COLUMN IF NOT EXISTS token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_invite_links_token
  ON room_invite_links(token)
  WHERE token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_invite_links_token
  ON friend_invite_links(token)
  WHERE token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_room_invite_links_creator_room
  ON room_invite_links(created_by, room_id, created_at DESC)
  WHERE token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_friend_invite_links_creator
  ON friend_invite_links(created_by, created_at DESC)
  WHERE token IS NOT NULL;
