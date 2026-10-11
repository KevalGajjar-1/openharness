#!/usr/bin/env python3
"""Break native launch boundaries in an explicitly owned disposable worktree."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_NATIVE_MUTATIONS_OWNED') == '1'
launch = 'src/engines/nativeLaunchCompatibility.golden.spec.ts'
grid = 'src/lib/gridConfigCompatibility.golden.spec.ts'
guard = 'src/engines/kit/nativeLaunchGuard.spec.ts'
prepare = 'src/engines/prepareNativeLaunch.spec.ts'
settings = 'src/engines/kit/hookSettings.spec.ts'
mutations = [
    ('ignore captured executable', 'src/lib/engineLaunch.ts', 'opts.native?.executable?.command ?? engineBin(engine)', 'engineBin(engine)', launch, ''),
    ('drop original first prompt', 'src/lib/engineLaunch.ts', 'if (opts.firstPrompt) argv.push(...firstPromptArgs(engine, opts.firstPrompt))', 'if (false) argv.push(...firstPromptArgs(engine, opts.firstPrompt!))', launch, ''),
    ('disconnect installer dispatch', 'src/engines/kit/nativeInstall.ts', '      dispatch(runtime, file, hash)', '      void runtime; void file; void hash', launch, ''),
    ('accept unfinished visible executable', 'src/engines/prepareNativeLaunch.ts', 'obligation && !obligation.complete ? held(obligation.detail) : found', 'false ? held(obligation!.detail) : found', prepare, 'newly visible executable'),
    ('skip fresh post-install observation', 'src/engines/prepareNativeLaunch.ts', 'const prepared = await inspect(engine, source)', 'const prepared = found', prepare, 'fresh post-install snapshot'),
    ('drop final hook proof', 'src/engines/kit/nativeLaunchGuard.ts', 'files: launch.proofs.flatMap(item => item.files)', 'files: []', guard, 'changed hook contents'),
    ('ignore prepared executable identity', 'src/engines/kit/nativeLaunchGuard.ts', '!==p.identity)throw 0;', '===undefined)throw 0;', guard, 'after shell startup'),
    ('change published configuration', 'src/lib/publishedGridConfig.ts', 'await previous.replace(file.content, attempt, previous.content === null)', "await previous.replace(file.content + '\\n', attempt, previous.content === null)", grid, ''),
    ('adopt interstage hook edit', 'src/engines/kit/hookSettings.ts', "if (!required.current()) throw new HookPreparationHeld('the required native hooks changed before the inbox update')", 'void required', settings, 'between the two reservations'),
    ('approve first owned block only', 'src/engines/kit/hookReview.ts', 'for (const [blockIndex, block] of blocks.entries())', 'for (const [blockIndex, block] of [...blocks.entries()].slice(0, 1))', settings, 'earlier optional hook'),
    ('own marker-only foreign commands', 'src/engines/kit/messagesHook.ts', "return value === messagesCommand(root, node)", "return value === messagesCommand(root, node) || value.includes('harness-agent-messages')", 'src/engines/kit/messagesHook.spec.ts', ''),
    ('forget prepared dispatch authority', 'src/core/agents/launches.ts', "if (!authority.current()) return { state: 'unconfirmed' }", 'void authority', 'src/core/agents/launches.spec.ts', 'before invocation'),
]
environment = dict(os.environ, TZ='UTC', TMPDIR='/tmp', HARNESS_CONNECTIONS_PORT='0')
for key in ('TMUX', 'TMUX_PANE', 'RECORD_NATIVE_LAUNCH_GOLDEN', 'RECORD_GRID_CONFIG_GOLDEN'):
    environment.pop(key, None)
tmux = cli.parent / '.harness/tmux'
tmux.mkdir(parents=True, exist_ok=True)
environment['TMUX_TMPDIR'] = str(tmux)


def run(specs, pattern=''):
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1']
    if pattern:
        command += ['-t', pattern]
    return subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=240)


baseline = run(sorted({item[4] for item in mutations}))
assert baseline.returncode == 0, 'Unchanged baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr
print('Unchanged baselines passed', flush=True)
failures = []
for label, relative, before, after, spec, pattern in mutations:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([spec], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': NOT caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        path.write_text(original)
if failures:
    raise SystemExit('Uncaught mutations: ' + ', '.join(failures))
