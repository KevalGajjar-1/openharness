import { describe, expect, it } from 'vitest'
import { isGitCommit, parseTestSummary, TurnStats } from './turnStats.js'

describe('parseTestSummary', () => {
  it.each([
    ['vitest', 'Test Files  3 passed (3)\n      Tests  44 passed (44)', { passed: 44, failed: 0 }],
    ['vitest failing', '      Tests  2 failed | 42 passed (44)', { passed: 42, failed: 2 }],
    ['jest', 'Tests:       2 failed, 31 passed, 33 total', { passed: 31, failed: 2 }],
    ['pytest', '==== 44 passed, 2 failed in 3.1s ====', { passed: 44, failed: 2 }],
    ['pytest failed first', '==== 2 failed, 44 passed in 3.1s ====', { passed: 44, failed: 2 }],
    ['cargo', 'test result: ok. 12 passed; 0 failed; 0 ignored', { passed: 12, failed: 0 }],
    ['mocha', '  9 passing (40ms)\n  1 failing', { passed: 9, failed: 1 }],
    ['mocha clean', '  9 passing (40ms)\n', { passed: 9, failed: 0 }],
    ['go', 'ok  \tpkg/a\t0.2s\nFAIL\tpkg/b\t0.1s\nok  \tpkg/c', { passed: 2, failed: 1 }],
  ])('%s', (_name, tail, want) => expect(parseTestSummary(tail)).toEqual(want))

  it('the last summary wins', () => {
    const tail = 'Tests: 1 failed, 2 passed, 3 total\nnoise\n==== 9 passed in 1.0s ===='
    expect(parseTestSummary(tail)).toEqual({ passed: 9, failed: 0 })
    expect(parseTestSummary('==== 9 passed in 1.0s ====\nTests: 1 failed, 2 passed, 3 total'))
      .toEqual({ passed: 2, failed: 1 })
  })
  it('sums the cargo result lines of every test binary', () => {
    const tail = [
      'Running unittests src/lib.rs', 'test result: ok. 10 passed; 0 failed; 0 ignored',
      'Running tests/it.rs', 'test result: FAILED. 3 passed; 2 failed; 0 ignored',
      'Doc-tests foo', 'test result: ok. 0 passed; 0 failed; 0 ignored',
    ].join('\n')
    expect(parseTestSummary(tail)).toEqual({ passed: 13, failed: 2 })
  })
  it('go counts package lines only', () => {
    expect(parseTestSummary('FAIL\n FAIL\tpkg\t0.002s\nFAIL')).toEqual({ passed: 0, failed: 1 })
    expect(parseTestSummary('ok 1 - x\nok 2 - y')).toBeNull()
  })
  it('returns null without a summary', () => {
    expect(parseTestSummary('all good')).toBeNull()
    expect(parseTestSummary('')).toBeNull()
  })
})

describe('isGitCommit', () => {
  it.each([
    'git commit -m "x"', 'cd cli && git commit -am x', 'GIT_AUTHOR_NAME=a git commit -m x',
    'git -C sub commit -m x', 'git add . && git commit -m x',
    'git -c k=v commit -m x', 'git --no-pager commit', '(git commit -m x)',
    'npm publish --dry-run && git commit -m x', 'git commit -m "explain --dry-run"',
  ])('true: %s', (c) => expect(isGitCommit(c)).toBe(true))
  it.each([
    'git commit --dry-run', 'git log', 'echo git commit', 'git commitment', 'git commit-tree abc', 'cat <<EOF\ngit commit\nEOF', '',
  ])('false: %s', (c) => expect(isGitCommit(c)).toBe(false))
})

describe('worst-case timing', () => {
  const ms = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t }
  it('isGitCommit survives 200 repeated -c tokens', () => {
    expect(ms(() => isGitCommit('git' + ' -c'.repeat(200) + ' x'))).toBeLessThan(50)
    expect(ms(() => isGitCommit('git' + ' -c'.repeat(40) + ' x'))).toBeLessThan(50)
  })
  it('isGitCommit caps a long line', () => {
    expect(ms(() => isGitCommit('git' + ' -a'.repeat(5000) + ' x'))).toBeLessThan(50)
  })
  it.each([
    ['digits', '9'.repeat(600)],
    ['spaces', ' '.repeat(600)],
    ['tests lines', 'Tests '.repeat(100)],
    ['passed', '1 passed '.repeat(66)],
    ['passing', '1 passing\n'.repeat(60)],
    ['ok tabs', 'ok\t\t\t'.repeat(100)],
  ])('parseTestSummary on adversarial tail: %s', (_n, tail) => {
    expect(ms(() => parseTestSummary(tail))).toBeLessThan(50)
  })
})

describe('TurnStats', () => {
  const run = (s: TurnStats, _id: string, command: string, isError = false, tail = '') => {
    s.toolResult('a', command, isError, tail)
  }
  it('counts a successful commit only', () => {
    const s = new TurnStats()
    run(s, '1', 'git commit -m x')
    run(s, '2', 'git commit -m y', true)
    run(s, '3', 'git commit -m z', false, 'nothing to commit, working tree clean')
    expect(s.take('a')).toEqual({ commits: 1 })
  })
  it('keeps the last test run, counting failed runs too', () => {
    const s = new TurnStats()
    run(s, '1', 'npm test', false, 'Tests: 5 passed, 5 total')
    run(s, '2', 'npm test', true, 'Tests: 1 failed, 4 passed, 5 total')
    expect(s.take('a')).toEqual({ testsPassed: 4, testsFailed: 1 })
  })
  it('take clears; an empty turn gives {}', () => {
    const s = new TurnStats()
    expect(s.take('a')).toEqual({})
    run(s, '1', 'git commit -m x')
    s.take('a')
    expect(s.take('a')).toEqual({})
  })
  it('reads test summaries only from a test command', () => {
    const s = new TurnStats()
    run(s, '1', 'cat ci.log', false, 'Tests: 5 passed, 5 total')
    expect(s.take('a')).toEqual({})
    run(s, '2', 'npm test', false, 'Tests: 5 passed, 5 total')
    expect(s.take('a')).toEqual({ testsPassed: 5, testsFailed: 0 })
  })
  it('ignores a tool without a command', () => {
    const s = new TurnStats()
    s.toolResult('a', undefined, false, 'Tests: 5 passed, 5 total')
    expect(s.take('a')).toEqual({})
  })
})
