//! SQLite schema. Records are stored as JSON with only the columns lookups need
//! indexed, so a protocol field added later is an additive change rather than a
//! migration of every row.

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS rooms (
    room_id      TEXT PRIMARY KEY,
    earliest_seq INTEGER NOT NULL DEFAULT 1,
    body         TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS participants (
    participant_id  TEXT PRIMARY KEY,
    room_id         TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    body            TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS participants_by_room ON participants (room_id);
CREATE UNIQUE INDEX IF NOT EXISTS participants_by_credential ON participants (room_id, credential_hash);

CREATE TABLE IF NOT EXISTS events (
    room_id TEXT NOT NULL,
    seq     INTEGER NOT NULL,
    body    TEXT NOT NULL,
    PRIMARY KEY (room_id, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS idempotency (
    room_id        TEXT NOT NULL,
    key            TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    PRIMARY KEY (room_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS handovers (
    handover_id TEXT PRIMARY KEY,
    room_id     TEXT NOT NULL,
    body        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS handovers_by_room ON handovers (room_id);

CREATE TABLE IF NOT EXISTS controls (
    room_id               TEXT NOT NULL,
    target_participant_id TEXT NOT NULL,
    body                  TEXT NOT NULL,
    PRIMARY KEY (room_id, target_participant_id)
) STRICT;

CREATE TABLE IF NOT EXISTS invites (
    digest           TEXT PRIMARY KEY,
    room_id          TEXT NOT NULL,
    state            TEXT NOT NULL,
    bound_attempt_id TEXT,
    body             TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS invites_by_room ON invites (room_id);

CREATE TABLE IF NOT EXISTS message_requests (
    event_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    received_at INTEGER,
    response_event_id TEXT,
    requires_reply INTEGER NOT NULL,
    body TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS message_requests_pending ON message_requests(room_id,seq) WHERE requires_reply=1 AND response_event_id IS NULL;
CREATE INDEX IF NOT EXISTS message_requests_group ON message_requests(room_id,json_extract(body,'$.conversationId'));

CREATE INDEX IF NOT EXISTS events_message_id ON events(room_id,json_extract(body,'$.eventId'));
CREATE INDEX IF NOT EXISTS events_reply_to ON events(room_id,json_extract(body,'$.replyTo')) WHERE json_extract(body,'$.type')='message';
CREATE INDEX IF NOT EXISTS events_receipt_to ON events(room_id,json_extract(body,'$.payload.eventId')) WHERE json_extract(body,'$.type')='message.received';
`;
