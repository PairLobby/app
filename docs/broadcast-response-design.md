# Broadcast receipts and coordinated answers

Implementation update: explicit multi-agent messages and `@all` now use the [group conversation queue](group-conversations.md), with one turn per selected agent, pass, skip/cancel, and sequential/parallel modes. The automatic relevance decisions and one-winner broadcast policy below remain a separate proposal; unaddressed room chatter does not wake agents.

Proposal after the inline-mention fix, 2026-09-19. Not implemented by the chat-display patch.

## Required behavior

A general message must have a receipt obligation for every eligible agent present when it is sent. Each agent then records whether it should answer. Answering should not create a race, duplicate work, or an endless conversation. A directed message keeps its explicit recipient; mentioning Codex in the middle of a sentence must not create a broadcast.

## Separate receipt, judgment, and speaking

1. The relay commits the message and a snapshot of eligible agent participant IDs. Late joiners see history but do not inherit old receipt obligations. The sender and read-only guests are excluded. Offline agents remain visibly pending; a connection cannot acknowledge on their behalf.
2. Each connected device receiver durably stores the message, then posts an idempotent delivery receipt. This is ordinary code and requires no model turn. Label it **Received**, not **Read by the model**. Keep it distinct from the existing addressed-request acknowledgement.
3. Each agent records one `offer` or `pass` decision for the broadcast. Its receiver may apply explicit deterministic policy to obvious non-work (system notices, receipts, its own output). Semantic judgments about meaningful new messages need model work when rules cannot establish the answer. Batch pending broadcasts for a busy agent into one decision turn, with an explicit decision per message ID.
4. The relay grants one willing agent a response lease. Prefer an explicitly requested role/capability, then use a rotating order among willing agents to avoid always choosing the same agent. Only the lease owner performs the full task and posts the first answer.
5. Other agents' recorded decisions remain visible, but an answer does not automatically wake every model again. A human can request another perspective, or an agent can explicitly delegate to a named participant. Those are new bounded requests, not an automatic reply-all loop.

Round-robin is a speaking rule here. It does not force every agent to produce a full answer. If everybody passes, show **No agent offered to answer**, with concise pass reasons available, instead of leaving an unanswered-looking message. If a decision or response deadline expires, show which agent is delayed/offline; never manufacture an acknowledgement or model response.

## Cost boundary

Waiting and delivery receipts cost no inference. If every agent must independently understand each fresh broadcast before deciding, that entails up to one judgment call per agent, plus the selected responder's work. A short output alone does not make that cheap: loading a native coding agent's full context can dominate the cost. The earlier real receiver smoke test demonstrated that overhead.

For an economical default, use a bounded context for judgment: the new message, a short room/task summary, and that agent's declared role/current assignment. Record that as a relevance decision, not a claim the agent reviewed its entire project. An explicit deep review can invoke its full runtime. Implementing a separate smaller-model judge requires an explicit model/billing choice; do not silently switch from the user's subscription to a paid API.

A stricter low-cost alternative is one deterministic round-robin nominee at a time; everyone receives, but only the nominee evaluates, passing to the next when necessary. This costs less but **does not meet the requirement that every agent independently decides on every broadcast**. It should be an optional room policy, not a hidden substitution.

Bound decision frequency, outstanding broadcasts, automatic delegation depth, and response grants per root message. No reminder timer invokes the model. Explicit user follow-ups or new work events may do so.

## Relay and receiver changes

- Add a per-agent broadcast receipt/decision table keyed by `(messageId, participantId)`: queued, received, offered, passed, timed-out, revoked. Preserve membership-at-send and distinguish offline from absent.
- Add reply ownership keyed by message ID, with a lease, fencing token, and deterministic rotating cursor. A reconnect cannot create competing speakers or authorize a stale winner.
- Persist decisions and replies in the receiver's outbox before transmission. Retry idempotently. Recover uncertain execution without repeating tools blindly.
- A new broadcast gets its own root ID; receipts, decisions, and final replies never become fresh broadcast obligations. Keep existing directed-request receipt/reply semantics unchanged.
- Release a grant if its owner declines before starting. After uncertain execution, require reconciliation before granting the same side-effecting task to another agent.
- Represent sender targeting separately from read access: everyone may read a directed message, while only the target owes its answer. Optional delivery receipts from other agents do not transfer that obligation.

## Chat presentation

Normal view: `hjoncour → everyone`, followed by `Received by codex, claude · waiting for cursor`. Then show `codex will answer`, or a concise no-answer/failure state. Keep per-agent pass reasons and protocol IDs behind an explicit details/debug view. Never label a transport receipt as model comprehension.

## Acceptance checks

Every eligible agent has exactly one obligation; duplicate/reordered deliveries cannot add judgments or answers. Offline/revoked/late-joining agents are represented correctly. Concurrent offers yield one winner, with fair rotation across messages. A crashed winner cannot be replaced blindly during uncertain work. All-pass and timeouts are explicit. Replies/receipts cause no new inference. Measure actual provider usage with several agents; separately account for relay writes and connection costs.
