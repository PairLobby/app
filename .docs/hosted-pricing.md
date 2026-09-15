# Hosted plans and unit economics

Working proposal, checked 2026-09-15. Prices are USD/month before tax, pending confirmation. These are bounded workload estimates, not a guarantee against bugs, attacks, refunds, or support costs. The existing polling relay has not been benchmarked as this proposed hosted transport.

## Suggested launch limits

All limits are pooled per billing workspace, including work performed by invitees. Agents are not paid seats. A person cannot share their Dev login as a substitute for Team membership.

| | Dev | Team | Enterprise |
|---|---:|---:|---:|
| Monthly price | $3 | $10 | $99 |
| Human accounts | 1 | 5 | 25 |
| Teams | 1 | 1 | 5 |
| Simultaneous agent sessions | 8 | 40 | 200 |
| Concurrent rooms | 3 | 10 | 50 |
| Accepted work events/month | 20,000 | 80,000 | 1,000,000 |
| API requests/month | 200,000 | 1,000,000 | 5,000,000 |
| Retained event storage | 128 MiB | 640 MiB | 5 GiB |
| Rolling history | 7 days | 30 days | 30 days |
| Maximum event payload | 32 KiB | 32 KiB | 32 KiB |
| Maximum participants/room | 9 | 16 | 32 |

A “message” means an accepted work event, including handover creation/amendment, counted once by its idempotency key. Broadcast deliveries and replay are not additional messages, but replay consumes a read budget. Monthly count and storage limits both apply: a full-size payload uses storage faster. Agent session limits are workspace-wide, not per room. Departed or revoked sessions release capacity. Closing a socket alone does not release a durable participant slot; use leave or revoke for finished agents. Automated stale-session leases are a future improvement. Controls, removal, close, and export need reserved bounded capacity after the work quota is reached. Rate-limit abuse of these paths independently.

For a normal eight-hour day over 22 workdays: Dev allows ~114 messages/hour (one every 32 seconds across its agents); Team ~455/hour; Enterprise ~5,682/hour. Maximum burst throughput is a separate reliability limit, initially 5/15/50 accepted work events per second per workspace, subject to load testing. These are proposed limits to implement, not measured service capacity.

Enterprise optional usage: $10 per additional 100,000 work events, with 500,000 associated API requests, capped at the purchased allowance. Existing storage and connection limits still apply. Start with prepaid blocks or an explicit monthly spend ceiling; do not enable uncapped automatic overages. Extra people/teams need their own agreed package. $99 does not include SSO, custom contracts, dedicated capacity, an SLA, or unlimited human support.

## Provider rates

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): $5/month account minimum; 10M requests and 30M CPU-ms included; then $0.30/M requests and $0.02/M CPU-ms. Static asset requests are free.
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): 1M requests and 400k GB-s included; then $0.15/M requests and $12.50/M GB-s. Each active object is billed at 128 MB (0.128 GB). SQLite includes 25B reads, 50M writes, and 5 GB-month; overage is $0.001/M reads, $1/M writes, $0.20/GB-month. Index updates and deletes are writes. Included pools are account-wide, never per customer. DO compute overage is rounded to whole billing units.
- [Stripe Payments US](https://stripe.com/pricing): domestic cards 2.9%+$0.30; international +1.5%; FX +1% when applicable. [Stripe Billing](https://stripe.com/billing/pricing): another 0.7%. Merchant country and settlement currency must be confirmed. The model reserves the full 6.1%+$0.30, not only the domestic headline fee; Canadian merchant pricing must replace this when confirmed.

## Reproducible calculation

Run `node scripts/hosted-costs.mjs`. At the full allowance, assume **24 database row writes per accepted work event, including one receipt and cleanup** (events, state, idempotency, indexes and eventual cleanup), **1,000 rows read, 10ms Worker CPU, and 50ms DO active time per API request**, plus maximum retained storage. Charge all usage at marginal rates, ignoring included allowances to avoid allocating them repeatedly. Authentication, email and telemetry are additional reserves, not free at arbitrary scale.

The model includes 5% extra control events (at least 1,000), one free receipt per work event, 20% reserved control-request capacity and 20% storage headroom. These reserved paths are independently bounded; “controls remain available after the work quota” does not mean unlimited free writes. Strict metering itself costs one SQLite row write per admitted request. The relay caps replay pages at 100 events/256 KiB and retained handover snapshots at 64 per room.

```
E = monthly work allowance + max(1,000, monthly work allowance × 5%)
R = monthly request allowance × 1.2
S = retained GiB × 1.2
H = E × 24 / 1,000,000 × $1
  + R / 1,000,000 × $1                     [request metering writes]
  + R × 1,000 / 1,000,000 × $0.001         [row reads]
  + R / 1,000,000 × ($0.30 + $0.15)        [Worker + DO requests]
  + R × 10 / 1,000,000 × $0.02             [Worker CPU]
  + R × 0.050 × 0.128 / 1,000,000 × $12.50 [DO duration]
  + S × 1.073741824 × $0.20                [physical storage]
payment reserve = revenue × 6.1% + $0.30
contribution = revenue − H − payment reserve
```

| At full allowance, including reserves | Dev | Team | Enterprise |
|---|---:|---:|---:|
| Marginal hosting estimate | $1.19 | $5.45 | $42.87 |
| Payment reserve | $0.48 | $0.91 | $6.34 |
| Contribution before fixed costs/support | $1.33 | $3.64 | $49.79 |
| Contribution margin | 44.2% | 36.4% | 50.3% |
| Hosting stress: twice writes/CPU/active duration | $1.76 | $7.81 | $69.75 |
| Contribution under that stress | $0.75 | $1.28 | $22.91 |

Budget a further $0.10/$0.25/$1 per workspace for ordinary auth/email/telemetry as a planning reserve, then replace it with measured usage. This leaves approximately $1.23/$3.39/$48.79 before fixed costs. The $5 fixed Workers minimum requires at least five fully utilized Dev customers or two Teams under this conservative marginal model. The actual small invoice depends on shared allowances and overage rounding. Round account-level DO request/duration overage before applying rates, not each customer's model. A $12.50 duration billing increment can be material at very small scale.

100 Dev customers at their caps: $300 revenue − $48.30 payment reserve − $119.14 marginal hosting − $10 auth reserve − $5 fixed ≈ $117.56 before support, tax, refund/dispute costs and rounding. 1,000 Dev customers: approximately $1,220.59 on the same conservative marginal model. Neither number is profit after founder salary.

A $10 Enterprise usage block adds 100k events, 500k calls, proportional reserves and no extra storage. At the same rates its estimated variable hosting is $4.16, or $6.85 under stress. Payment fees reserved at 6.1%+$0.30 are $0.91, leaving $4.93 normally or $2.24 under stress. Blocks are prepaid, expire at the current billing-period end, do not roll over and never trigger automatic charges.

A single refund/dispute or a few minutes of personal support can consume many months of Dev contribution. Consider annual billing at $36, which reduces the fixed transaction fee per equivalent month from $0.30 to $0.025 without discounting the product. Do not promise an SLA on these prices.

## Why transport changes are required

One continuously active DO for 30 days costs `2,592,000 × 0.128 × 12.50 / 1M = $4.1472` at marginal duration pricing, before requests/storage. A non-hibernating socket or held-open long poll can defeat the $3 price. Use the hibernation API and no persistent timers/outbound connections in idle room objects.

At one HTTP poll/second, eight agents generate 20.736M requests/month even with zero work messages. Workers+DO request charges alone are $9.33 at marginal rates, before reads or CPU. The hosted CLI path uses socket notifications and consumes live frames directly; local relays retain polling. Use socket notifications, cursor-based catch-up with indexed queries, bounded reconnect backoff, and a request allowance enforced on the server.

## What still needs measurement and enforcement

- Atomic workspace-wide event, byte, room, session, seat and request ceilings; retries cannot double-charge, and parallel rooms cannot exceed the shared budget.
- Independent abuse limits before expensive auth/database work; sampled logs without transcript/token content; request body limits; idle hibernation verified in production metrics.
- Replay bounded by both rows and bytes, indexed reads, retention pruning and deletion including handover snapshots/idempotency records; aggregate database overhead measured separately from payload.
- Load test burst concurrency and all-agents fan-out, reconnect storms, sustained full-quota usage, stalled clients, lease expiry and subscription cancellation. There is no honest fixed maximum total site concurrency before these tests. For example 1,000 Dev accounts would allow 8,000 agent sessions by policy, not prove 8,000 tested sessions.
- Billing state granted by verified webhooks/current provider state, never a success URL; signed events idempotent and out-of-order safe; usage access expires when the paid period ends. Missed webhooks require reconciliation.

No model tokens, inference servers, remote execution, attachments or arbitrary bulk transfers are included. PairLobby transports conversations between agents running on users' own machines.

## Implementation and launch status

The account and relay implementation is in `packages/hosted`, and the website account pages are in the website repository. Runtime integration tests cover authentication, invite redemption, strict quota races, team isolation, socket hibernation and live client delivery. These are correctness tests, not a capacity benchmark. Stripe production credentials and an end-to-end sandbox subscription lifecycle test remain launch prerequisites; purchases are disabled until then. Self-service plan changes should stay disabled in the Stripe portal until seat/team downgrade behavior is verified; cancellation and payment-method management can be enabled.
