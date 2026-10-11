---
name: harness
description: You are running inside Harness, which can run other coding agents (Claude Code, Codex, and more) as visible sessions on this machine or the person's other machines. Use when the work calls for another model, another machine, a long-running job that should outlive this turn, or something the person should watch; or to check on, message or close harnesses you started. Not for quick fan-out inside one task: use your own sub-agents for that.
---

# Harness

You are a harness: one agent session that Harness runs and the person can see. You can start other harnesses,
read them, wait for them, message them and close them, with the `harness` command.

## When to use it

Only when your own tools cannot do the job:

1. **Another model**: a second opinion from Codex, a task suited to another agent.
2. **Another machine**: the Mac mini, a GPU box (`harness machines` lists them).
3. **Work that outlives you**: a long job that should keep running after your turn or your context ends.
4. **The person should see it**: everything you start appears in Harness, where they can watch and step in.

A quick parallel search or edit inside your own task is cheaper with your own sub-agents. Do that instead.

## New harness or an existing one

1. Run `harness ps`. It lists the harnesses here: state, who started each, and what each is about.
2. You may give work only to a harness **you started** (STARTED BY says `you`), or to a teammate in a tab with
   Agent Messages on (`harness send` alone lists them). A harness the person is driving is theirs: you may
   `show` and `wait` on it, never send it work.
3. If one you may use is already on **the same work on the same subject**, and it is idle, send it there: it
   has the context. Otherwise start a new one: for unrelated work, for work to run in parallel, for another
   agent or machine, or when the matching one is busy with something else.

## The verbs

```
harness ps [--all]                                  # the harnesses here
harness new [agent] [@machine] [folder] --name <name> -- <task>
harness wait <name>[,<name>…] [--any] [--timeout 30m]
harness show <name>                                 # its state, the last ask and its answer
harness send <name> "text"                          # a follow-up to one you started
harness close <name>                                # when you are done with one you started
```

- **Always `--name`** what you start (`--name reviewer`): an unnamed harness takes its session's title, which
  changes. Every verb also takes the start of an id.
- Put the whole task in `-- <task>`: what to do, where, what done looks like, and how to report back.
  The harness reads that it came from you, and how to answer you.
- `wait` exits 0 when it is idle, 3 when it needs the person (a question or a permission: only the person
  answers those, so tell them), 4 when it stopped, 124 on timeout.
- Read the result with `show` instead of asking for a summary; send a follow-up only when you need more.
- `close` what you started once you have what you need. It keeps the conversation; the person can resume it.

## Limits

At most 8 live harnesses of yours, 20 starts in 10 minutes, and a harness you start may start others, but
the ones it starts may not. Every limit refuses with a message; do not work around it. Never ask a harness to
publish, deploy, delete or push to main for you: those are the person's to ask for.
