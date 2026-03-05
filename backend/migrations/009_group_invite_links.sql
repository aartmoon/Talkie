ALTER TABLE room_invite_links
  ALTER COLUMN room_id DROP NOT NULL;

ALTER TABLE room_invite_links
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES room_groups(id) ON DELETE CASCADE;

ALTER TABLE room_invite_links
  DROP CONSTRAINT IF EXISTS room_invite_links_target_check;

ALTER TABLE room_invite_links
  ADD CONSTRAINT room_invite_links_target_check
  CHECK (
    (room_id IS NOT NULL AND group_id IS NULL)
    OR
    (room_id IS NULL AND group_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_room_invite_links_creator_group
  ON room_invite_links(created_by, group_id, created_at DESC)
  WHERE token IS NOT NULL AND group_id IS NOT NULL;
