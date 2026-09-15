/** Upgrade only retained legacy events; no synthetic acknowledgements or replies. */
export const REQUEST_BACKFILL_SQL = `
INSERT OR IGNORE INTO message_requests(event_id,room_id,seq,received_at,response_event_id,requires_reply,body)
SELECT json_extract(body,'$.eventId'),room_id,seq,NULL,NULL,
       CASE WHEN json_extract(body,'$.replyTo') IS NULL THEN 1 ELSE 0 END,
       json_object('roomId',room_id,'eventId',json_extract(body,'$.eventId'),'seq',seq,
           'from',json_extract(body,'$.senderId'),'to',json_extract(body,'$.recipientId'),
           'text',json_extract(body,'$.payload.text'),'at',json_extract(body,'$.at'),
           'requiresReply',json(CASE WHEN json_extract(body,'$.replyTo') IS NULL THEN 'true' ELSE 'false' END),
           'receivedAt',NULL,'responseEventId',NULL,'respondedAt',NULL,'progressAt',NULL)
FROM events WHERE json_extract(body,'$.type')='message'
AND json_extract(body,'$.senderId') IS NOT NULL AND json_extract(body,'$.recipientId') IS NOT NULL;
UPDATE message_requests AS r SET received_at=(
    SELECT min(json_extract(e.body,'$.at')) FROM events e WHERE e.room_id=r.room_id
    AND json_extract(e.body,'$.type')='message.received'
    AND json_extract(e.body,'$.senderId')=json_extract(r.body,'$.to')
    AND json_extract(e.body,'$.payload.eventId')=r.event_id
);
UPDATE message_requests SET body=json_set(body,'$.receivedAt',received_at);
UPDATE message_requests AS r SET response_event_id=(
    SELECT json_extract(e.body,'$.eventId') FROM events e WHERE e.room_id=r.room_id
    AND json_extract(e.body,'$.type')='message'
    AND json_extract(e.body,'$.replyTo')=r.event_id
    AND json_extract(e.body,'$.senderId')=json_extract(r.body,'$.to')
    AND json_extract(e.body,'$.recipientId')=json_extract(r.body,'$.from')
    AND coalesce(json_extract(e.body,'$.payload.responseStage'),'final')='final'
    ORDER BY e.seq LIMIT 1
);
UPDATE message_requests AS r SET body=json_set(body,'$.responseEventId',response_event_id,'$.respondedAt',(
    SELECT json_extract(e.body,'$.at') FROM events e WHERE e.room_id=r.room_id AND json_extract(e.body,'$.eventId')=r.response_event_id LIMIT 1
));
INSERT OR REPLACE INTO meta(key,value) VALUES('message_requests_v1','complete');
`;
