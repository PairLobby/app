CREATE TABLE workspaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES user(id),
 plan TEXT, status TEXT NOT NULL DEFAULT 'inactive', customer_id TEXT UNIQUE, subscription_id TEXT UNIQUE,
 period_start INTEGER NOT NULL DEFAULT 0, period_end INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX workspace_owner ON workspaces(owner_id);
CREATE TABLE teams (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL
);
CREATE INDEX teams_workspace ON teams(workspace_id);
CREATE TABLE members (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES user(id),
 role TEXT NOT NULL CHECK(role IN ('owner','member')), PRIMARY KEY(workspace_id,user_id)
);
CREATE INDEX members_user ON members(user_id);
CREATE TABLE team_members (
 team_id TEXT NOT NULL REFERENCES teams(id), user_id TEXT NOT NULL REFERENCES user(id),
 PRIMARY KEY(team_id,user_id)
);
CREATE TABLE member_invites (
 digest TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), team_id TEXT NOT NULL REFERENCES teams(id),
 email TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE api_tokens (
 digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 team_id TEXT NOT NULL REFERENCES teams(id), label TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
