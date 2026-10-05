# Plan: invite people by `@username`

Status: draft for discussion, 2026-10-04. Nothing in this document is built.

## Goal

In a room, typing `/invite @maria` should bring Maria in: she is told about it, the room
appears in her room list, and she joins by selecting it, from her terminal and with
whichever of her agents she chooses. No code is copied between people.

The same gesture has to work in three settings:

1. **Friends and coworkers on separate plans.** Two people with their own accounts,
   each paying (or not) for themselves, share one room.
2. **Company accounts.** A coworker in the same organization is added with `@`, with
   name completion from the company directory and company rules applied.
3. **People who have no account yet.** `/invite maria@example.com` sends them a
   sign-up link that lands in the room. This is the growth path.

## What exists today

| Piece | Today | Gap |
| --- | --- | --- |
| `/invite` | Mints a code (`/invite`, `/invite member`, `/invite observer`, `/invite as <name>`); the code is passed along by hand. | No way to address a person. |
| Accounts | `pairlobby login` approves a terminal; an account is an email and a user id. `find online` lists rooms the account owns or is allowed into; `join online <room>` joins one without a code. | No username, no way to look someone up. |
| Hosted room admission | Owners can restrict a room to a verified-email allowlist. Each join creates its own participant, so one account can bring a terminal and several agents. | The allowlist is edited by email in settings; the invitee is never told. |
| `@` in chat | `@codex`, `@all` address participants already in the room. | `@` has no meaning for people outside the room. |
| Local relays (`pairlobby serve`) | Accountless: codes, join by name on the LAN or tailnet. | No identity to address. |
| Room list | Shows rooms saved on this device. Network-open rooms are being added on `feature/network-rooms-in-list`. | Nothing shows "you were invited". |

Two facts shape the design:

- **The allowlist already is the invitation.** An account on a room's allowlist can
  join with its terminal and its agents. `/invite @maria` is mostly "put Maria's
  account on the allowlist, and tell her".
- **The relay never runs inference.** Each person's agents run on their own machine
  with their own provider login. Inviting someone does not make the inviter pay for
  the invitee's model usage; it only adds participants to a hosted room.

The account service is in the separate private worker repository. This plan describes
what it must offer; the details of its storage and billing code have to be checked
against that repository before any estimate is trusted.

## Concepts to add

### Usernames

Every account gets one unique handle: `@maria`, 3–30 characters, lowercase letters,
digits, `-` and `_`, case-insensitive, chosen at sign-up and changeable with a cooldown.
Old handles are held for a period so they cannot be taken over immediately.

Company members also resolve inside their organization, so `@maria` finds the coworker
first. An explicit `@maria@acme` (or `@acme/maria`) reaches into an organization from
outside when that organization allows it.

Handles reveal that an account exists. Lookup is therefore exact-match only, rate
limited, and never returns an email address. Prefix completion is offered only for
contacts and coworkers (below).

### Invitations

An invitation is a record on the account service:

- room, inviter account, invitee account (or email, for someone without an account)
- role: member or observer, same meaning as `/invite member|observer`
- agent allowance: how many of the invitee's agents may join (default 1; 0 for "just you")
- state: pending, accepted, declined, revoked, expired
- expiry (default 7 days, same idea as `invite --expires-in`)

Accepting an invitation adds the invitee's account to the room's allowlist with that
role and allowance. Declining or expiring does nothing to the room. Revoking a pending
invitation withdraws it; removing someone already in the room stays `/kick`.

### Contacts

After two accounts have shared a room, each is the other's contact. Contacts get name
completion on `/invite @…` and can invite each other without the extra confirmation
that a first-time invitation shows. An account can block another account; a blocked
account's invitations are dropped silently.

### Organizations

A company account is an organization with members, roles (owner, admin, member), a
verified email domain, and seats. It adds:

- a **directory**: `/invite @` completes coworkers' handles and names
- **direct add**: inside the organization an admin setting chooses whether a coworker
  must accept, or is added immediately and simply notified
- **policy**: whether rooms may include people outside the organization, and whether
  members may accept invitations to outside rooms
- **ownership**: rooms created by members belong to the organization, so they survive
  someone leaving and an admin can reassign or close them

## How it works for the person

### Inviting

```
/invite @maria                    member, may bring one agent
/invite @maria observer           read-only
/invite @maria --agents 0         just Maria, no agents
/invite @maria @joe @acme/lee     several at once
/invite maria@example.com         no account yet: emails a sign-up link
/invites                          pending invitations for this room, with revoke
```

`/invite` with no `@` keeps today's behaviour and still mints a code. The room shows
one line, visible to everyone: `hugo invited @maria (member, 1 agent)`, and later
`maria joined` as it does now.

In chat, `@name` in a normal message keeps meaning "a participant in this room".
Only `/invite` looks names up outside the room, so the two never collide.

### Being invited

- Opening `pairlobby` shows invitations at the top of the room list, state `invited`,
  with who invited you. Enter asks to accept, then joins and opens the chat. This uses
  the same "row you have not joined yet" treatment as the network rooms work.
- `pairlobby invitations` lists them outside the list; `accept <room>` and
  `decline <room>` act on one. `--json` for agents and scripts.
- Other commands end with a one-line reminder when an invitation is waiting, the same
  way update notices appear today.
- Email notification, on by default, with a per-account switch.

### Bringing agents

Once accepted, the room is one of the invitee's account rooms, so what exists already
applies: `pairlobby join online <room> --runtime claude`, or `/claude` and `/spawn` from
inside the chat. The allowance caps how many of that account's agents are in the room at
once; the owner can change it per person in `/settings`.

An agent never accepts an invitation by itself. Accepting is a human action in a
terminal or on the website; agents see invitations only in `--json` output and are told
by the skill not to act on them.

## Plans and billing

The rule to build around: **the room belongs to one plan, and that plan sets its
limits.** Everyone else is a guest of that room.

| Question | Proposed answer |
| --- | --- |
| Who pays for the room? | The owner's plan (a person's plan, or the organization's). |
| Does the invitee need a paid plan? | No. A free account can accept and take part. |
| What do the invitee's own plan limits apply to? | Rooms the invitee owns. |
| What limits a shared room? | The owner's plan: participants per room, agents per guest, history retention, number of rooms with outside guests. |
| Who pays for the invitee's model usage? | The invitee, through their own provider login, as today. |
| Company seats | A coworker uses a seat. An outside guest does not, up to a per-plan guest limit. |

When an invitation would exceed a limit, `/invite` says which limit and what raises it,
and sends nothing. Limits are checked again at acceptance, because the room may have
filled up in between.

The actual numbers, and whether guest limits exist at all on each tier, are a pricing
decision that this plan does not make.

## What has to be built

### Account service (private worker repository)

- Handles: claim, change, look up by exact match, reserved names, cooldown.
- Invitations: create, list for an account, list for a room, accept, decline, revoke,
  expire. Accept writes the room's allowlist entry.
- Email invitations for addresses without an account; the invitation attaches to the
  account once that email is verified.
- Contacts and blocks.
- Organizations: members, roles, domain verification, directory search, policy, room
  ownership.
- Plan checks at create and at accept.
- Notification email and a count of pending invitations on the existing account call.

### Hosted relay

- Allowlist entries carry a role and an agent allowance per account, not only an email.
- Admission counts an account's live agent participants against its allowance.
- A room event for "invited" and "invitation revoked", so the transcript explains who
  was asked in. Older clients must ignore the new event type without failing.

### CLI (this repository)

- `/invite @handle …` and `/invites` in `chat-commands.ts`; handle completion in
  `chat-completion.ts`.
- `pairlobby invitations`, `accept`, `decline`; `pairlobby profile --username`.
- Room list rows for invitations in `room-list.ts` and `room-browser.ts`.
- New calls in `online.ts`; the waiting-invitation reminder beside the update notice.
- Per-person allowance in `room-settings.ts`.
- Skill text: agents report invitations, never accept them.

### Local relays

A room on `pairlobby serve` has no account behind it and is usually unreachable from
the internet, so `/invite @maria` cannot work the same way. Two options:

1. **Hosted only (recommended first).** On a local room, `/invite @maria` explains that
   inviting by name needs a hosted room and offers the code as today.
2. **Delivery only (later).** When the inviter is logged in, the account service
   carries an ordinary invite code to Maria's invitation list. She can join only if her
   device can reach the relay (same network or tailnet). The relay itself stays
   accountless.

## Abuse and privacy

- Rate limits on lookups and on invitations per account per day; lower for new accounts.
- First-time invitations from a non-contact show the inviter's handle and room name
  only, and the invitee can block from the same screen.
- Room names are shown to people who have not joined. Owners should know this; a
  "hide room name until accepted" option covers sensitive rooms.
- No way to list handles, and no response that distinguishes "blocked you" from "does
  not exist".
- Organizations can turn off outside invitations in both directions.
- Every invitation, acceptance and revocation is recorded for the room owner, and for
  organization admins.

## Phases

| Phase | What ships | Depends on |
| --- | --- | --- |
| 0. Decisions | Handle rules, the billing rule above, guest limits per tier, whether local relays are in scope. | — |
| 1. Handles and invitations | Usernames; `/invite @handle` on hosted rooms; `pairlobby invitations`, accept, decline; invitation rows in the room list; room events. Personal accounts only. | Account service work; network-rooms list rows. |
| 2. Agents and limits | Agent allowance per invitee, plan checks, `/invites` with revoke, per-person settings. | Phase 1. |
| 3. Email and contacts | Invite by email with sign-up landing in the room; contacts, completion, blocks; notification email. | Phase 1. |
| 4. Organizations | Company accounts, directory completion, direct add, policy, organization-owned rooms, admin audit. | Phases 1–2. |
| 5. Local relays | Code delivery through the account service for rooms on `pairlobby serve`. | Phase 1; decision in phase 0. |

Phase 1 is the smallest thing that delivers the gesture end to end. Phase 4 is the
largest; if company accounts are the commercial priority, the organization model
should be designed during phase 0 so that phase 1's tables do not have to change.

## Open questions

1. Is a handle global, or does every handle live under a person or organization
   namespace from the start?
2. Do guests count against the room owner's plan at all on personal tiers?
3. Default agent allowance: one, or unlimited with a room-wide cap?
4. Inside an organization, is "add without acceptance" the default?
5. May a guest invite further people, or only the owner and admins? (Today anyone who
   can run `/invite` can mint a code.)
6. Should existing code invites remain available in rooms that an organization
   restricts to its members?
7. What does the hosted service already store per account and per room allowlist entry?
   This decides how much of phase 1 is new.
