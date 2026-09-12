# Phase A — the provider spike

The point is to find out what two real agent runtimes actually do in a room, and in particular what `pause` does to a running turn. Everything downstream depends on that answer: it decides whether PairLobby can honestly say "interrupt an agent" or only "an agent stops between turns".

Nothing in this repository's capability matrix has been measured. Fill it in from here.

## Setup, once

```sh
cd packages/cli && npm link && cd -            # puts `pairlobby` on PATH

mkdir -p ~/.claude/skills/pairlobby
cp integrations/claude-code/SKILL.md ~/.claude/skills/pairlobby/SKILL.md
```

For Codex, put the instructions where it will read them in whatever directory you run it from:

```sh
cp integrations/codex/AGENTS.md <that-directory>/AGENTS.md
```

Use a **throwaway repository** for the handover steps, not this one. Step 7 asks an agent to describe uncommitted work it cannot reach, and you do not want that experiment in a repository you care about.

## Running it

Three terminals: the relay, Claude Code, Codex. A fourth if you want to watch.

```sh
# terminal 1
pairlobby serve
```

Then prompt each agent in plain language — **do not paste commands into them.** The spike is partly testing whether the instructions are enough on their own. If an agent cannot work out the command, that is a finding; write it down rather than helping it.

| # | Terminal | Prompt | What to record |
| --- | --- | --- | --- |
| 1 | Claude Code | "Create a PairLobby room called spike and give me the invite code." | Did it find the skill unprompted? Did it report its session id? |
| 2 | Codex | "Join PairLobby room with code `<CODE>` as codex." | Did it join without help? Did it keep its session id for later commands? |
| 3 | Claude Code | "Ask codex in the room whether it can run the test suite." | Did it address the message rather than broadcasting? |
| 4 | Codex | "Check the room." | Did it read, and did it act only on what was addressed to it? |
| 5 | Claude Code | "Prepare a handover to codex for finishing the recovery tests." | Did it write the document itself? Was `dirty` / `missingPaths` accurate? |
| 6 | Codex | "Check the room and respond to the handover." | Did it name the exact revision? Did it verify the repo state before accepting? |
| 7 | Claude Code | Amend the handover after Codex declines. | Did it reuse the id and increment the revision? |
| 8 | **you** | While Codex is mid-task, run `pairlobby pause codex` | **The important one. See below.** |
| 9 | Codex | "Check the room." | What outcome did it acknowledge? Was it honest? |
| 10 | **you** | `pairlobby resume codex` | Did it resume, and acknowledge? |

## Step 8 is the one that matters

Give Codex something slow first — "run `sleep 60 && echo done`" — so there is a turn to interrupt. Then pause it from your terminal.

Record these as **three separate facts**, because they are three separate capabilities:

1. Did the **model's turn** end?
2. Did the **tool** stop?
3. Did any **child process** stop? (check with `ps`)

An agent that says `current_turn_cancelled` while `sleep` is still running in `ps` has told you something false, and that is the single most important result the spike can produce.

## Record the result

Fill in `integrations/README.md`. The three values mean different things and are not interchangeable:

- `verified` — you observed it work
- `unsupported` — you observed it fail
- `untested` — you did not try

Do not promote a cell to `verified` from documentation, from a plausible-looking log line, or from the agent's own claim about itself. Only from behaviour you watched.

```
| Runtime | Version tested | Unsolicited delivery | Cancel turn | Cancel tool |
```

Also record, in whatever form you like:

- **Every place an agent needed help** the instructions should have given it. This is the main product finding, and it is easy to forget because you will instinctively help.
- Exact runtime versions (`claude --version`, `codex --version`) and how each was authenticated.
- Anything that failed in a way the CLI reported badly.

## The decision this feeds

If neither runtime can end a turn on request, that is a legitimate outcome and the answer is **not** to build a workaround. It means:

- `pause` means "paused between turns", said plainly in the docs
- the README stops implying anything stronger
- a managed adapter gets estimated as real work, not assumed as a later detail

The roadmap's own gate: *"If managed interruption fails, keep cooperative messaging, change the promise, and estimate the adapter work before proceeding."*
