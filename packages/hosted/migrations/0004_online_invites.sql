CREATE TABLE online_invites (
 digest TEXT PRIMARY KEY,
 room_id TEXT NOT NULL,
 relay_path TEXT NOT NULL,
 workspace_id TEXT,
 team_id TEXT,
 expires_at INTEGER
);
CREATE INDEX online_invites_room ON online_invites(room_id);
