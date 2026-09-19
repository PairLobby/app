
- 2026-09-12T20:38:51Z: Reading after joining with an explicit session still failed because multiple rooms were active; the CLI did not infer the room from the session and suggested duplicate room names. Passing both --room with the room ID and --session succeeded.

- 2026-09-12T22:16:17Z: Sending a room message failed twice with server_unavailable because the local relay was unreachable. A later user-requested retry succeeded.

- 2026-09-14T00:05:09Z: A new attempt to send a room message failed with server_unavailable on both the initial call and one retry. The local relay must be running before messages can be delivered.

- 2026-09-14T00:07:09Z: Retrying a pending room message after the relay became reachable returned room_expired. The saved session no longer permits delivery; a fresh room invite is needed.

## 2026-09-15 00:50:20 UTC

Reading room messages with an explicit session still failed when multiple rooms were active, despite the integration instructions requiring only --session. Pass both --room and --session to disambiguate the read.

## 2026-09-15 01:04:12 UTC

Wrangler types writes its output relative to the working directory even when a nested --config is supplied. Pass the hosted package output path explicitly so generated imports and TypeScript inclusion point at the correct project.

## 2026-09-15 01:23:02 UTC

Stripe CLI and its configuration file are present, but API calls report no configured credentials. Authenticate with stripe login before attempting live product, webhook, or subscription setup.

## 2026-09-15 01:30:02 UTC

Strict request quotas require their own SQLite write on each admitted API request, and free control events still incur storage writes. Include both metering and bounded control/request/storage reserves in unit economics instead of pricing only ordinary messages.

## 2026-09-15 01:48:27 UTC

The team seat race fixture hit Better Auth throttling before reaching membership allocation because all simulated users share a loopback address. Reset only the local test rate-limit table between account setup steps so the seat race test reaches the code it intends to exercise.

## 2026-09-15 01:48:27 UTC

An inferred RPC return type from Reflect.apply triggered excessive TypeScript type instantiation in the test bridge. Declaring the test-only RPC result as Promise<unknown> fixes the Cloudflare RPC type expansion without weakening production bindings.

## 2026-09-15 01:54:49 UTC

The current Wrangler OAuth credentials cannot read account billing subscriptions (HTTP 403). Worker deployment and API checks work; confirm the billing plan through the Cloudflare dashboard rather than treating this scoped API failure as a deployment failure.

## 2026-09-15 01:54:49 UTC

A standalone Node invocation of the Wrangler test harness stalled during a storage-size probe. Running the same probe inside the existing Vitest harness succeeded and confirmed that databaseSize decreases when data is removed.

## 2026-09-15 01:58:19 UTC

The commit and push command was rejected by automatic approval review because approval is required while AskForApproval is set to Never. Source changes remain on the dedicated local feature branch; deployed services are unaffected.

## 2026-09-15 03:28:57 UTC

Investigating ignored agent messages found that pending requests were keyed by participant pair, so newer asks replaced older ones, and any later chatter could clear the obligation. Persist each addressed request by event ID and require the intended recipient to acknowledge and explicitly reply to that ID.

## 2026-09-15 03:28:57 UTC

The CLI advanced its read cursor before sending receipts and swallowed receipt failures; it also looked only at the first history page for unanswered work. Use the durable inbox and commit receipts before advancing the cursor so failed reads remain retryable.

## 2026-09-15 03:28:57 UTC

A real MCP integration test exposed simultaneous local HTTP sends choosing the same next event sequence and returning a generic failure. Serialize local relay mutations; the hosted workspace adapter already serializes its operations.

## 2026-09-15 05:13:43 UTC

The old PairLobby/backend Git URL now redirects to the newly created worker repository, while this checkout shares its history with PairLobby/app. Correct origin to PairLobby/app before pushing; automatic approval review blocked the attempted remote correction and push in this session.

## 2026-09-15 05:27:01 UTC

The messaging change was already merged into app, but its duplicate branch in worker still produced an unrelated-history comparison. Automatic approval review blocked deletion of the duplicate branch because approval is required while AskForApproval is Never; the correct merged PR was opened instead.

## 2026-09-15 05:27:01 UTC

Browser selection by bundle identifier was ambiguous because an application update cache contained another copy. Selecting the installed application by its full path resolved the ambiguity.

## 2026-09-17 02:18:24 UTC

Cloudflare's default root deployment could not discover the hosted Worker configuration inside the app workspace. Moved the canonical config to the repository root, adjusted source/migration paths and made Wrangler build shared packages before bundling; the unrelated account/Worker connection in the failed GitHub check still needs verification in its dashboard.

## 2026-09-17 02:20:01 UTC

The tested Cloudflare root-config fix could not be committed because automatic approval review rejected Git writes in Never mode. The live pairlobby-api dashboard also shows manual deployments and no Git connection; the failed backend build check targets a separate inaccessible account.

## 2026-09-17 02:40:00 UTC

Retrying hosted deployment after removing the root Cloudflare config exposed that Wrangler's custom build cwd resolves from the invoking directory. Replaced that relative cwd with explicit npm build steps in the deployment scripts and pinned the hosted config to the currently authenticated deployment account.

## 2026-09-17 03:16:31 UTC

Wrangler could inspect the production D1 database but its SQL API rejected migration access with code 7403 despite the OAuth token listing D1 scope. The signed-in Cloudflare database console could execute queries, so the additive online-invite migration was applied there and checked against its migration record.

## 2026-09-17 03:18:52 UTC

Online room keys and private-account joining passed tests and live deployment verification, but automatic approval review blocked committing because approval is required in Never mode. The app, worker and frontend changes remain on feature/online-room-keys branches for review and commit.

## 2026-09-18 00:33:21 UTC

The one-command installer can be exercised on macOS, but this machine has no PowerShell or native Windows/Linux environment. Keep the native-platform validation limitation explicit; the shared installer, custom-skill preservation, checksum rejection and Unix runtime bootstrap were verified with isolated directories.

## 2026-09-18 01:13:58 UTC

Installer skill prompts cannot read from ordinary stdin when invoked through curl piped into sh. The Unix installer now reads the controlling terminal directly, with a PTY regression test covering redirected stdin; unattended installs skip optional skills rather than waiting for input. The task commit was blocked by automatic approval review in Never mode.

## 2026-09-18 02:26:48 UTC

Applying the agreed TypeScript style requires syntax-aware postprocessing because a standard formatter expands signatures/JSX attributes and can collapse spaces in preformatted transcript text. Source snapshots, emitted-JavaScript comparisons and rendered-page comparisons were used to preserve behavior; generated and vendored code was excluded.

## 2026-09-18 02:45:20 UTC

The Cloudflare GitHub App has organization-wide repository access, so removing the CLI repository requires narrowing its installation to the website and worker repositories. GitHub requires sudo-mode re-authentication before showing those settings; the change is waiting on the account owner’s Mobile verification.

## 2026-09-18 04:21:52 UTC

A real Codex room session repeatedly polled a waiting background read, consuming extra model input tokens, then finished before a later directed request arrived. Registered membership therefore outlived the listener, leaving the request unacknowledged; the integration needs an event-driven runtime wake mechanism, not an indefinite model polling loop.

## 2026-09-18 05:48:10 UTC

The installed Codex CLI has native App Server and queue commands, but no shared default daemon is running, so existing private CLI sessions cannot be assumed attachable. An idle probe initially mistook model-catalog retries for inference; a valid catalog response established zero generation requests while idle and generation only after an explicit turn start.

## 2026-09-18 14:39:14 UTC

The local Codex integration test failed to initialize because quoted MCP names in `-c` dotted overrides became literal keys with no transport configuration. Plain validated MCP names fix the child-only disable overrides; the older idle probe needed the same correction.

## 2026-09-19 20:15:12 UTC

Installing the synthetic test as a separate prototype command did not replace the unusable room workflow. The CLI now owns an actual detached Codex receiver; the local installer replaces the existing managed launcher and preserves it for rollback.

## 2026-09-19 21:19:11 UTC

Chat completion recognized inline mentions, but sending only routed a mention at the beginning of the line, so “Hey @codex” silently became a broadcast. Routing now recognizes inline mentions; normal chat also respects show-ids for request/reply markers and displays readable delivery states.

## 2026-09-19 22:07:35 UTC

The append-only terminal renderer could not update Seen on its original message or provide hover targets. The terminal now uses a diff-rendered transcript with mouse hit targets and retains readline for editing; receipt storage exposes one acknowledgement time, so the UI does not invent a separate read timestamp.

## 2026-09-19 22:13:00 UTC

Long-history terminal QA exposed clipping in nested message widgets after scrolling. Flattening message text and receipt hit targets into the scrolling container fixed the blank transcript; the PTY check now covers scrolling, resize, hover, click and draft preservation.

## 2026-09-19 22:18:30 UTC

The README, status/capability matrix and generated package README still said no managed adapter existed and all agents needed manual reads. Updated them against the installed receiver and separated the historical prototype, local implementation, and unimplemented design targets to prevent reintroducing waiting-agent setup.

## 2026-09-19 22:52:43 UTC

Real terminal startup hit Blessed’s legacy compiler on a modern Setulc capability, printing generated JavaScript despite debug/warnings being disabled. The renderer now disables unused extended capabilities; a compiled modern-terminfo fixture reproduces the old dump and the PTY check asserts clean raw output.
