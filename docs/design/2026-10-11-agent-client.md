# Harness for agents

October 11, 2026. First version built (branch `agent-client`).

Web, desktop, phone and `hn` are Harness for people. This is Harness for the agents running in it: a few
`harness` verbs an agent calls from its shell to see other harnesses, start one, read it, wait for it, message
it and close it. Same daemon, no screen.

## Why

Agents already try to use Harness and build the missing parts themselves:

- The lamp team (October 10) made its own message IDs, coordination files in Git and a `team.sh` around a
  64-character key, and a Codex lead typed into a Claude pane with `tmux paste-buffer` because Harness had no
  way in. ([Agent Messages](2026-10-10-agent-messages.md) fixed the messaging; nothing yet covers start, read,
  wait or close.)
- Each piece exists apart: `harness new`, `harness send`, `harness search`, `harness orchestrator`, Harness
  Monitor's `hps`. None prints for a program, none waits, and none records that an agent started a harness.

The bet: agents will drive Harness far more than people do. A person opens 5 to 20 harnesses a day and reads
them; an orchestrating agent can open hundreds, around the clock, and check each one every few seconds. If that
holds, the agent verbs are the product and the windows become where people watch and steer.

### When an agent should use it

Only when Harness does what the agent's own tools cannot. A quick fan-out inside one task stays with the
engine's sub-agents (Claude Code's Agent tool, Codex sub-agents): cheaper, faster, results come straight back.
Harness is for:

1. **Another model**: Claude Code cannot start Codex, Gemini or Devin; Harness runs all thirteen engines.
2. **Another machine**: the Mac mini, the GPU box, a cloud agent.
3. **Work that outlives the caller**: a harness keeps running after the caller's turn, context or process ends,
   and resumes later.
4. **The person sees it**: what an agent starts appears as a pane on the desktop and the phone, where the person
   can watch, answer or stop it. Sub-agents are invisible.
5. **Existing peers**: harnesses the person started, in a tab with Agent Messages on.

Claude Code itself now has `ListAgents`, `SendMessage` and `notify_when_idle` for its own sessions on one
machine. The verbs below take the same shape on purpose; what Harness adds is every engine, every machine,
and the person's view of it.

## The agent's side

```
harness ps [--all]                                  # the harnesses here: state, who started each, what each is about
harness new [agent] [@machine] [folder] --name N -- <task>     # exists; now knows when an agent runs it
harness show <name> [--chars N]                     # its state, the last ask and the answer
harness wait <name>[,<name>…] [--any] [--timeout 30m]
harness send <name>[,<name>…] "text"                # exists (Agent Messages); now also to what you started
harness close <name> [--now]                        # save its screen and stop it; resumable
```

Text by default, for agents as much as people: they read it as well, and it is a third of JSON's size (`ps` on
the owner's Mac, 21 harnesses: 5.8 KB of text, 16.2 KB of JSON). `--json` for programs. Every error says what to run next.
`wait` exits 0 idle, 3 needs the person, 4 stopped or gone, 124 timed out.

**Close, not stop** (owner, October 11): `harness stop` stops the daemon, and an agent typing it with a name
left empty would have stopped Harness. `close` is the app's close (`agent_close`): it saves the screen, stops the
harness and keeps its conversation, and refuses while the harness is working unless `--now`.

The agent's instructions are a skill, [cli/skills/harness/SKILL.md](../../cli/skills/harness/SKILL.md): when to
use Harness at all, the rule below, the verbs and the limits. How it reaches agents (installed for Claude Code
and Codex, or a startup note) is not decided yet.

### ⌘N or ⌘P: new harness or an existing one

This is the choice ⌘B's router makes for a person ([auto router](2026-10-09-auto-router.md)). An agent makes it
itself: it is a capable model and knows its own task better than any router. It needs what the router sees,
which `harness ps` gives it (name, what it is about, state, engine, machine, folder, how long ago it stopped),
and one rule, in its startup note:

1. **Ownership first.** An agent may give work only to a harness it started, or to one in a tab with Agent
   Messages on. A harness a person is driving is read-only to agents: `show` and `wait` it, never `send`.
2. **Then sameness.** If a harness it may use is on the same work on the same subject (the router's question),
   and is idle or resumable, send there: it holds the context. Otherwise `new`: unrelated work, work to run in
   parallel, another engine or machine, or the matching harness is busy with something else.

No Jev: Jev is for ⌘B only.

## Who started it

Every harness an agent starts is recorded: one line in `<data>/agent-client/started.jsonl` of the daemon that owns
the agent's pane, with who started it (id, name, engine, machine), the new harness, the time and its depth. A
harness with no line was started by the person. `ps` shows it (STARTED BY: `person`, `you`, or a name), and
limits, `close` and measurement read it.

It is a file the CLI appends to, not a field in the core's registry, so this first version changes nothing in the
core and can be removed whole. Like Agent Messages it is a collaboration scope, not a sandbox: any process of the
same user can write it. If agents use this, the record moves into the registry beside `forkedFrom`, and the
windows can show it in the pane header.

The task a harness is started with carries one header line, so the new harness knows it is from an agent and not
the person (the lamp team's tmux paste read as the owner's), and how to answer:

```
[from lead · Claude Code · studio, the harness that started you. It reads your answer itself; to ask it something while you work: harness send lead "…"]

Review 3f2a9c1 …
```

The reply address is the name when it is a plain word or two, else the start of the id: an unnamed harness is
called by its session title, a sentence that can hold the comma `harness send` splits recipients on (found in the
live trial: "so we have built harness web,").

## Limits

Spawning is cheap, so runaway spawning is the risk (the Jev loops cost $60 at one caller). Every limit refuses
with a clear error; nothing is dropped silently.

- Live harnesses started by one harness: 8.
- Live harnesses started by agents, per machine: 40.
- Depth: an agent-started harness may start harnesses; one started two levels down may not.
- `new` per harness: 20 in 10 minutes.
- An agent never answers a permission dialog, and never closes a harness it did not start.

## How it works

`cli/src/agentClient/`, a CLI module outside the core, composed only of requests the daemon already answers.
No core change, no new service.

- **The line.** The daemon that owns the caller's pane (`@harness_daemon`, as `harness send` finds it), over its
  Unix socket, as a **tool**, not a window: a window's registration turns on the question watcher and counts as
  someone looking. `harness new` registered as a window too; it no longer does.
- **Who is calling.** `$TMUX_PANE`, matched against every harness the daemon lists, stopped and offline ones
  included: matching only live ones made an agent "the person" whenever the daemon listed it offline for a moment
  (found by the end to end). A person's terminal, or a pane Harness did not make, is the person. A pane Harness
  made whose harness it no longer knows is what is left of an agent: it may look, not close or start.
- **`ps`**: `agents_list`, plus `agent_recent` (the daemon's stored turn summaries and the person's last asks,
  no transcript read) for up to 40 live harnesses. 0.8 s for 22 harnesses on the owner's Mac.
- **`show`**: `agent_close` in `inspect` mode for needs-input (the screen, as the windows read it), and
  `session_get` with a `limit`, a page at a time from the end, at most four pages: never the whole transcript
  (the attach OOM, October 3). The answer is the text after the turn's last tool call.
- **`wait`**: looks every 3 s with `inspect`. Done when it is not working and has finished something: a turn it
  was seen working on, or one its transcript shows ended. A harness just started is idle for a moment before its
  task is typed, so idle alone is not done; one with nothing asked of it two minutes after it started is.
- **`close`**: `agent_close`, `idle` mode (or `now`). An agent closes only what it started; the person anything.
- **`new`**: `lib/newCommand.ts` asks `agentOrigin()` when run from an agent's pane: the limits, the header, the
  record. It also stopped printing "Created" for a launch the daemon refused or could not confirm: with a
  creation id the daemon answers `{state}`, and only `created` made a harness.
- **`send`**: Agent Messages lets a harness and the harnesses it started message each other with no tab, on the
  same machine (another machine checks deliveries against its own tabs and has no record of who started what).
  It also takes the start of an id. Kept in a `started` log beside the tabs' logs.
- **Another machine.** `new @mini` works as before; `show`, `wait` and `close` find a harness the caller started
  there through its record and reach it over the paired relay.

### Verified

- Unit: the module (42 tests), `harness new` (16), Agent Messages (20, with lineage and id prefixes).
- End to end on the real daemon with the fake engines (`e2e/agentClient.e2e.ts`, 10 s): from an agent's pane,
  `ps`, `new` with a task, `wait`, `show` (the header and the echoed answer), `send` both ways with no tab on,
  `close` refused for its own harness and for one its child did not start, then allowed for its child. The fake
  engine now takes a first message on the command line, as both CLIs do; it used to drop it.
- Live, on the owner's Mac from this session's own pane against the running daemon: `ps` (22 harnesses, 0.8 s),
  `new claude --name probe-child -- "Reply with the single word ready"` (0.4 s), `wait` (idle in 7 s), `show`
  (the header and "ready"), `close` refused for "Harness OS", allowed for the child. `send` answered
  `UNSUPPORTED` there: that daemon is a dev build whose Agent Messages backend is not deployed until Monday.
- Not claimed: whether agents choose well (the eval below).

## Measuring it

- **Use:** harnesses started per day by people and by agents, and the ratio. Agents passing 10× people on our
  own machines within two weeks is the signal to invest.
- **Choice:** an eval in the style of `cli/scripts/route-eval/` (English only, with a red team and a held-out
  set): a desk, a task, and whether a Claude Code and a Codex agent pick `send` to the right harness, `new`, or
  their own sub-agents.
- **Outcome:** for the same tasks, with and without the verbs, does the work finish and is it better.

## Not now

An MCP server (a thin wrapper once the CLI holds), agents outside Harness (a Claude Code plugin, `npx`, the MCP
registries), the windows' tree of who started whom, `ps` across all machines (today: this one, and what you
started elsewhere), parent and child messaging across machines.
