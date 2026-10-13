"""Recovery must prove the original exec without inheriting launcher identity."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
reader = 'src/engines/kit/nativeRearmProof.ts'
unit = 'src/engines/kit/nativeRearmProof.spec.ts'
mutations = [
    ('kernel boot is ignored', reader, 'if (bootId !== witness.boot)', 'if (false)', 'holds boot evidence'),
    ('direct pane parent is ignored', reader, ' || engine.parentPid !== root.pid', '', 'holds parent evidence'),
    ('engine classification is skipped', reader, '|| !nativeRearmEngine(engine, observed, declared)', '|| false', 'holds image evidence'),
    ('native entry digest is ignored', reader,
     "&& createHash('sha256').update(path).digest('hex') === engine.directEntryDigest", '&& true', 'requires a positive executed entry'),
    ('final entry digest is ignored', reader,
     '|| final.rows.get(engine.pid)!.directEntryDigest !== engine.directEntryDigest', '|| false', 'holds a final entry-digest change'),
    ('pane continuity is ignored', reader,
     'placed.rootPid !== placement.rootPid || placed.command !== placement.command', 'false', 'holds a final pane-command change'),
    ('final root incarnation is ignored', reader,
     'controlIdentity(final.rows.get(root.pid)!) !== rootIdentity || ', '', 'holds a final root-birth change'),
    ('retained receipt is not verified', reader, 'receipt.verify(); verifyFence(); current()', 'verifyFence(); current()', 'holds a final receipt change'),
    ('final persisted authority is ignored', reader, 'receipt.verify(); verifyFence(); current()', 'receipt.verify(); current()', 'holds a final control change'),
    ('caller can replace original fence', reader, 'const { verify: verifyFence, current: currentFence } = fence',
     'const verifyFence = () => fence.verify(), currentFence = () => fence.current()', 'captures original fence'),
    ('deadline reply never settles', reader,
     "try { held('evidence deadline expired') } catch (error) { reject(error) }", 'void reject', 'bounds a stalled boot reply'),
    ('expired operation frees an occupied slot', reader, 'expired = true', 'expired = true; running--', 'bounds a stalled boot reply'),
    ('expired work retains authority', reader, "if (expired) return held('evidence deadline expired')", '', 'bounds a stalled boot reply'),
    ('synchronous setup expiry leaks capacity', reader, 'const timeout = budget.remaining()\n    running++',
     'running++\n    const timeout = budget.remaining()', 'does not reserve an actual read slot'),
    ('older tmux owner wrapper is refused', reader, "const launch = wrapper && command?.startsWith(wrapper) ? command.slice(wrapper.length) : command",
     'const launch = command', "accepts only this daemon"),
    ('foreign daemon wrapper is accepted', reader,
     'command?.startsWith(wrapper) ? command.slice(wrapper.length)',
     "command?.startsWith('/usr/bin/env HARNESS_DAEMON=') ? command.slice(wrapper.length)", "accepts only this daemon"),
    ('complete spaced vendor path is lost', reader, 'if (!engine.argv && !observed.nativeArgv) {', 'if (false) {', 'digest-checks complete vendor'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', unit,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=30)


result = run()
if result.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native replacement proof baseline passed', flush=True)
failures = []
for label, path, before, after, pattern in mutations:
    source = cli / path
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run(pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)

if sys.platform == 'darwin':
    # Exact native padding is independently causal. A successful helper read
    # with empty argv0 must not slide into a different script or environment.
    source = cli / 'native/darwin-process-images.c'
    original = source.read_text()
    before = 'at = sizeof(int) + ((end - sizeof(int) + 1 + align - 1) / align) * align;'
    after = 'at = end; while (at < size && !raw[at]) at++; (void)align;'
    assert original.count(before) == 1
    command = ['python3', 'native/test_process_images.py',
               'ProcessImagesTest.test_uncertain_entry_boundaries_never_shift_into_arguments_or_environment']
    baseline = subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=60)
    if baseline.returncode:
        raise SystemExit('Native baseline failed.\n' + baseline.stdout + baseline.stderr)
    try:
        source.write_text(original.replace(before, after))
        result = subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=60)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append('empty argv0 is skipped as alignment')
            print(output, flush=True)
        else:
            print('empty argv0 is skipped as alignment: caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
