CREATE TABLE IF NOT EXISTS room_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS group_channels (
  group_id UUID NOT NULL REFERENCES room_groups(id) ON DELETE CASCADE,
  room_id UUID PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('text', 'voice')),
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_channels_group_position
  ON group_channels(group_id, channel_type, position, created_at);

WITH legacy_rooms AS (
  SELECT r.id, r.created_by, r.created_at
  FROM rooms r
  LEFT JOIN direct_rooms d ON d.room_id = r.id
  LEFT JOIN group_channels gc ON gc.room_id = r.id
  WHERE d.room_id IS NULL
    AND gc.room_id IS NULL
),
legacy_creators AS (
  SELECT DISTINCT created_by FROM legacy_rooms
),
inserted_groups AS (
  INSERT INTO room_groups (name, created_by)
  SELECT 'Сервер ' || u.username, lc.created_by
  FROM legacy_creators lc
  JOIN users u ON u.id = lc.created_by
  RETURNING id, created_by
)
INSERT INTO group_channels (group_id, room_id, channel_type, position)
SELECT ig.id,
       lr.id,
       'text',
       ROW_NUMBER() OVER (PARTITION BY lr.created_by ORDER BY lr.created_at) - 1
FROM legacy_rooms lr
JOIN inserted_groups ig ON ig.created_by = lr.created_by;
