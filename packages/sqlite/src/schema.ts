//! SQLite schema. Records are stored as JSON with only the columns lookups need
//! indexed, so a protocol field added later is an additive change rather than a
//! migration of every row.

export const SCHEMA_VERSION = 3;

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
CREATE INDEX IF NOT EXISTS rooms_by_auto_close ON rooms (json_extract(body, '$.autoCloseAt')) WHERE json_extract(body, '$.lifecycle') = 'open' AND json_extract(body, '$.autoCloseAt') IS NOT NULL;

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
CREATE INDEX IF NOT EXISTS message_requests_unreceived ON message_requests(room_id,seq) WHERE received_at IS NULL;
CREATE INDEX IF NOT EXISTS message_requests_pending_recipient ON message_requests(room_id,json_extract(body,'$.to'),seq) WHERE requires_reply=1 AND response_event_id IS NULL;
CREATE INDEX IF NOT EXISTS message_requests_unreceived_recipient ON message_requests(room_id,json_extract(body,'$.to'),seq) WHERE received_at IS NULL;
CREATE INDEX IF NOT EXISTS message_requests_unreceived_message ON message_requests(room_id,json_extract(body,'$.to'),json_extract(body,'$.messageSeq')) WHERE received_at IS NULL;

-- A range only when the advance covers addressed requests; first receipt times survive without per-request writes.
CREATE TABLE IF NOT EXISTS receipt_ranges (
    room_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    through_seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (room_id, participant_id, through_seq)
) STRICT;

CREATE TABLE IF NOT EXISTS files (
    file_id    TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    event_id   TEXT,
    body       TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS files_by_room ON files (room_id, created_at);
CREATE INDEX IF NOT EXISTS files_by_event ON files (room_id, event_id);
CREATE INDEX IF NOT EXISTS files_by_expiry ON files (json_extract(body,'$.retention.expiresAt'),file_id) WHERE json_extract(body,'$.retention.mode')='temporary';

CREATE TABLE IF NOT EXISTS file_chunks (
    file_id TEXT NOT NULL,
    idx     INTEGER NOT NULL,
    bytes   BLOB NOT NULL,
    PRIMARY KEY (file_id, idx)
) STRICT;

CREATE INDEX IF NOT EXISTS events_message_id ON events(room_id,json_extract(body,'$.eventId'));
CREATE INDEX IF NOT EXISTS events_messages_by_room ON events(room_id,seq) WHERE json_extract(body,'$.type')='message';
CREATE INDEX IF NOT EXISTS events_reply_to ON events(room_id,json_extract(body,'$.replyTo')) WHERE json_extract(body,'$.type')='message';
CREATE INDEX IF NOT EXISTS events_receipt_to ON events(room_id,json_extract(body,'$.payload.eventId')) WHERE json_extract(body,'$.type')='message.received';
CREATE INDEX IF NOT EXISTS events_by_sender ON events(room_id,json_extract(body,'$.senderId'),seq) WHERE json_extract(body,'$.type')='message';

CREATE TABLE IF NOT EXISTS listings (
    listing_id     TEXT PRIMARY KEY,
    room_id        TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    owner          TEXT NOT NULL,
    body           TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS listings_by_participant ON listings (room_id, participant_id);
CREATE INDEX IF NOT EXISTS listings_by_owner ON listings (owner);
CREATE INDEX IF NOT EXISTS listings_by_owner_id ON listings (owner, listing_id);

CREATE TABLE IF NOT EXISTS member_defaults (
    handle TEXT PRIMARY KEY,
    body   TEXT NOT NULL
) STRICT;
`;
