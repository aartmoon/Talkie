ALTER TABLE room_members
ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

UPDATE room_members rm
SET role = 'admin'
FROM rooms r
WHERE rm.room_id = r.id
  AND rm.user_id = r.created_by;

CREATE INDEX IF NOT EXISTS idx_room_members_role ON room_members(room_id, role);
