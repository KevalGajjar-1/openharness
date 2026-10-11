---
name: harness
description: Harness runs coding agents (Claude Code, Codex and others) as harnesses, sessions the person can watch and step into from the Harness app, on this computer or their other machines. Use it to start another agent on a task and read its answer, run several agents in parallel, wait for a background agent to finish, keep a long job running after this turn, or check on, message or close a harness. Not for quick fan-out inside one task: use your own sub-agents for that.
---

# Harness

Harness runs coding agents in terminal sessions called harnesses, and shows each one to the person in its
desktop, web and phone apps. With the `harness` command you can start harnesses, read them, wait for them,
message them and close them.

## Is it here?

Run `harness version`. If there is no such command, Harness is not installed. Ask the person before you
install it; it takes two commands and no account:

```
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness start
```

`harness start` starts Harness on this computer. Harnesses on this computer need no account; `harness login`
is only for the person's other machines and their phone. The agent you start must be installed as well
(`claude` for Claude Code, `codex` for Codex) and signed in to its own provider.

## When to use it

Only when your own tools cannot do the job:

1. **Another model**: a second opinion from Codex, a task suited to another agent.
2. **Another machine**: the Mac mini, a GPU box (`harness machines` lists them).
3. **Work that outlives you**: a long job that should keep running after your turn or your context ends.
4. **The person should see it**: everything you start appears in Harness, where they can watch and step in.

A quick parallel search or edit inside your own task is cheaper with your own sub-agents. Do that instead.

## Inside a harness, or outside

- **You run in a harness** (Harness made your terminal pane): Harness knows who you are. `harness ps` marks what
  you started (STARTED BY says `you`), each harness you start is told it comes from you and how to reach you,
  `harness send` works, and the limits below are counted for you.
- **You run in any other terminal**: Harness cannot tell you from the person. Nothing records what you start
  (STARTED BY says `person`), and `harness send` is not available: put everything in the task when you start a
  harness. Keep the names you start, and treat only those as yours.

## New harness or an existing one

1. Run `harness ps`. It lists the harnesses here: state, who started each, and what each is about.
2. You may give work only to a harness **you started**, or to a teammate in a tab with Agent Messages on
   (`harness send` alone lists them). A harness the person is driving is theirs: you may `show` and `wait` on
   it, never send it work, never close it.
3. If one you may use is already on **the same work on the same subject**, and it is idle, send it there: it
   has the context. Otherwise start a new one: for unrelated work, for work to run in parallel, for another
   agent or machine, or when the matching one is busy with something else.

## The verbs

```
harness ps [--all]                                  # the harnesses here
harness new [agent] [@machine] [folder] --name <name> -- <task>
harness wait <name>[,<name>…] [--any] [--timeout 30m]
harness show <name> [--chars N]                     # its state, the last ask and its answer
harness send <name> "text"                          # a follow-up to one you started
harness close <name> [--now]                        # when you are done with one you started
```

- **Always `--name`** what you start (`--name reviewer`): an unnamed harness takes its session's title, which
  changes. Every verb also takes the start of an id.
- `agent` is `claude` (the default), `codex`, or another agent installed on that machine. The folder defaults
  to the current directory.
- Put the whole task in `-- <task>`: what to do, where, what done looks like, and how to report back. A task
  holds 2,000 characters; for a longer one, write it to a file and name the file in the task.
- `wait` exits 0 when it is idle, 3 when it needs the person (a question or a permission: only the person
  answers those, so tell them), 4 when it stopped or is gone, 124 on timeout. `--timeout 0` waits as long as
  it takes.
- Read the result with `show` instead of asking for a summary; send a follow-up only when you need more.
- `close` what you started once you have what you need. It keeps the conversation; the person can resume it.
  It refuses while the harness is working, unless `--now`.
- Add `--json` to any verb for JSON. Every error says what to run next.

## Example: a second opinion from Codex

```
harness new codex --name reviewer -- "Review the changes on this branch against main for bugs. Do not edit files. Answer with the findings, most serious first, each with file and line."
harness wait reviewer --timeout 20m
harness show reviewer
harness close reviewer
```

To keep working meanwhile, start it, go on with your own work, and run `harness wait reviewer` when you need
the answer. For several at once, start each with its own name and wait on all of them:
`harness wait api-tests,ui-tests`.

## Limits and rules

- At most 8 live harnesses of yours, 20 starts in 10 minutes, and a harness you start may start others, but
  the ones it starts may not. Every limit refuses with a message; do not work around it.
- Never answer a harness's question or permission prompt yourself, and never type into it some other way.
- Never ask a harness to publish, deploy, delete or push for you: those are the person's to ask for.
- If Harness's MCP server is connected, its tools do the same as these verbs, under the same rules.
