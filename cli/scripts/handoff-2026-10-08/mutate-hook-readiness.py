#!/usr/bin/env python3
"""Check startup wiring mutations in an explicitly owned disposable worktree."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_HOOK_MUTATIONS_OWNED') == '1'
hooks = 'src/core/engines/hooks.ts'
golden = 'src/core/engines/hookStartup.golden.spec.ts'
mutations = [
    ('wrong hook port', hooks, 'hooks.install(port, nativeOptions)', 'hooks.install(port + 1, nativeOptions)', golden, ''),
    ('omit native vendors', hooks, 'of OTHER_INSTALLERS)', 'of OTHER_INSTALLERS.slice(0, 0))', golden, ''),
    ('ignore selected vendors', hooks, 'if (options.only && !options.only.has(vendor)) return', 'if (false) return', golden, ''),
    ('retain writes after shutdown', hooks, 'close: adoptions.close', 'close: () => {}', 'src/core/engines/hooks.spec.ts', 'returns shutdown authority'),
    ('await hooks at readiness', 'src/core/main.ts', ': installEngineHooks(hookPort', ': await installEngineHooks(hookPort', 'src/startupOrder.spec.ts', 'native hook maintenance'),
]
environment = dict(os.environ, TZ='UTC', TMPDIR='/tmp', HARNESS_CONNECTIONS_PORT='0')
for key in ('TMUX', 'TMUX_PANE', 'RECORD_HOOK_STARTUP_GOLDEN'):
    environment.pop(key, None)
tmux = cli.parent / '.harness/tmux'
tmux.mkdir(parents=True, exist_ok=True)
environment['TMUX_TMPDIR'] = str(tmux)


def run(specs, pattern=''):
    argv = ['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1']
    if pattern:
        argv += ['-t', pattern]
    return subprocess.run(argv, cwd=cli, env=environment, text=True, capture_output=True, timeout=120)


baseline = run(sorted({item[4] for item in mutations}))
assert baseline.returncode == 0, 'Unchanged baseline failed.\n' + baseline.stdout + baseline.stderr
print('Unchanged baseline passed', flush=True)
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
