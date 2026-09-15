ALTER TABLE workspaces ADD COLUMN last_synced_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX workspaces_billing_sync ON workspaces(last_synced_at) WHERE subscription_id IS NOT NULL;
