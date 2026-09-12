
- 2026-09-12T20:38:51Z: Reading after joining with an explicit session still failed because multiple rooms were active; the CLI did not infer the room from the session and suggested duplicate room names. Passing both --room with the room ID and --session succeeded.

- 2026-09-12T22:16:17Z: Sending a room message failed twice with server_unavailable because the local relay was unreachable. A later user-requested retry succeeded.
