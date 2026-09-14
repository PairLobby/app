
- 2026-09-12T20:38:51Z: Reading after joining with an explicit session still failed because multiple rooms were active; the CLI did not infer the room from the session and suggested duplicate room names. Passing both --room with the room ID and --session succeeded.

- 2026-09-12T22:16:17Z: Sending a room message failed twice with server_unavailable because the local relay was unreachable. A later user-requested retry succeeded.

- 2026-09-14T00:05:09Z: A new attempt to send a room message failed with server_unavailable on both the initial call and one retry. The local relay must be running before messages can be delivered.

- 2026-09-14T00:07:09Z: Retrying a pending room message after the relay became reachable returned room_expired. The saved session no longer permits delivery; a fresh room invite is needed.
