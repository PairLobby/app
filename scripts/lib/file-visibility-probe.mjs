// Portable fixture used inside Node SQLite and an actual local Durable Object.
export function seedVisibility(exec, large = false) {
    const rooms = large ? 1 : 4;
    const count = large ? 6000 : 60;
    const records = [];
    const roomIds = [];
    for (let room = 0; room < rooms; room++) {
        const roomId = 'rm_' + String(room).padStart(26, '0');
        const earliest = large ? 3001 : room * 15 + 1;
        roomIds.push(roomId);
        exec('INSERT INTO rooms(room_id,earliest_seq,body) VALUES(?,?,?)', roomId, earliest, JSON.stringify({name: 'Visibility fixture'}));
        for (let index = 1; index <= count; index++) {
            const eventId = 'ev_' + String(index).padStart(26, '0');
            exec('INSERT INTO events VALUES(?,?,?)', roomId, index, JSON.stringify({eventId, seq: index, type: 'message'}));
            const fileId = 'fl_' + String(room * 10000 + index).padStart(26, '0');
            const unattached = !large && index % 10 === 0;
            const orphan = !large && index % 11 === 0;
            const reference = unattached ? null : orphan ? 'ev_' + 'Z'.repeat(26) : eventId;
            const uploading = unattached && index % 20 === 0;
            const file = {roomId, fileId, name: `file-${index}.txt`, size: 100, mediaType: 'text/plain', sha256: '0'.repeat(64), uploaderId: 'pt_' + 'A'.repeat(26), createdAt: index, eventId: reference, ...(uploading ? {uploading: true} : {})};
            exec('INSERT INTO files VALUES(?,?,?,?,?,?)', fileId, roomId, 100, index, reference, JSON.stringify(file));
            records.push({roomId, fileId, visible: unattached || orphan || index >= earliest, attached: reference !== null, uploading});
        }
    }
    if (!large) {
        const roomId = roomIds[1];
        // Multiple references to one event ID must stay hidden if any match is hidden.
        const eventId = 'ev_' + 'D'.repeat(26);
        exec('INSERT INTO events VALUES(?,?,?)', roomId, 0, JSON.stringify({eventId, seq: 0, type: 'message'}));
        exec('INSERT INTO events VALUES(?,?,?)', roomId, 100, JSON.stringify({eventId, seq: 100, type: 'message'}));
        const fileId = 'fl_' + 'D'.repeat(26);
        exec('INSERT INTO files VALUES(?,?,?,?,?,?)', fileId, roomId, 100, 100, eventId, JSON.stringify({fileId, roomId, eventId, size: 100, name: 'duplicate.txt'}));
        records.push({roomId, fileId, visible: false, attached: true, uploading: false});
    }
    return {roomIds, records};
}

export async function probeVisibility(store, all, predicate, fixture) {
    const query = `SELECT file_id FROM files WHERE ${predicate} ORDER BY file_id`;
    const plan = all('EXPLAIN QUERY PLAN ' + query).map((row) => row.detail);
    if (!plan.some((line) => /events_message_id.*<expr>=\?/.test(line))) {
        throw new Error(`File visibility must seek the event-ID index, not scan a room's history: ${JSON.stringify(plan)}`);
    }
    const expected = fixture.records.filter((file) => file.visible).map((file) => file.fileId).sort();
    const actual = all(query).map((file) => file.file_id);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error('The visibility predicate changed which exact file IDs are visible');
    }
    for (const roomId of fixture.roomIds) {
        const rows = fixture.records.filter((file) => file.roomId === roomId);
        const expectedBytes = rows.filter((file) => file.visible).length * 100;
        if (await store.files.usedBytes(roomId) !== expectedBytes) {
            throw new Error('The adapter quota calculation disagrees with visible file bytes');
        }
        const attached = (await store.files.attachedFiles(roomId)).map((file) => file.fileId).sort();
        if (JSON.stringify(attached) !== JSON.stringify(rows.filter((file) => file.visible && file.attached).map((file) => file.fileId).sort())) {
            throw new Error('The adapter attachment listing disagrees with visibility');
        }
        if (fixture.records.length < 1000) {
            for (const file of rows) {
                const found = await store.files.file(roomId, file.fileId);
                if (Boolean(found) !== (file.visible && !file.uploading)) {
                    throw new Error('The adapter file lookup disagrees with retention/upload visibility');
                }
                const other = fixture.roomIds.find((id) => id !== roomId);
                if (other && await store.files.file(other, file.fileId) !== null) {
                    throw new Error('A file escaped its room boundary');
                }
            }
        }
    }
    return {files: fixture.records.length, visible: actual.length, plan};
}
