// Drives pre-push.sh, pre-commit.sh and owners.mjs against scratch repos, with
// nx, gh, uptime and getconf stubbed. The test logs under fixtures/ are real
// Vitest 3.2, Jest 29 and Nx 21 output.
// Usage: node --test tools/hooks/hooks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const zero = '0'.repeat(40);

function stubs(dir) {
  const bin = join(dir, 'bin');
  const files = {
    // Records each call; `affected` and `run-many` print their own log.
    nx: `#!/bin/sh
echo "$*" >>"${dir}/nx.calls"
case "$1" in
  graph) cp "${here}/fixtures/graph.json" "\${2#--file=}" ;;
  affected) cat "$NX_FIRST_LOG" 2>/dev/null; exit "\${NX_FIRST_RC:-0}" ;;
  run-many) cat "$NX_RERUN_LOG" 2>/dev/null; exit "\${NX_RERUN_RC:-0}" ;;
esac`,
    gh: '#!/bin/sh\nexit 1',
    uptime: '#!/bin/sh\necho "up 1 day, load averages: ${FAKE_LOAD:-0.50} 0.50 0.50"',
    getconf: '#!/bin/sh\necho 10',
  };
  execFileSync('mkdir', ['-p', bin]);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(bin, name), body + '\n');
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

// A clone of a bare origin whose main holds a/ (one project) and b/.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
  const repo = join(dir, 'repo');
  const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
  const git = (...args) =>
    execFileSync('git', [...ident, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('remote', 'add', 'origin', join(dir, 'origin.git'));
  const write = (file, text) => {
    execFileSync('mkdir', ['-p', dirname(join(repo, file))]);
    writeFileSync(join(repo, file), text);
  };
  const commit = (message, changes) => {
    for (const [file, text] of Object.entries(changes)) {
      if (text === null) git('rm', '-q', file);
      else write(file, text), git('add', file);
    }
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  commit('init', { 'a/util.ts': 'base\n', 'b/main.ts': 'base\n' });
  git('push', '-q', 'origin', 'main');
  // Merges main into the current branch and checks that it stopped on a conflict.
  const conflict = () => {
    const r = spawnSync('git', [...ident, 'merge', '-q', 'main'], { cwd: repo });
    assert.equal(r.status, 1, 'the merge should stop on a conflict');
  };
  return { dir, repo, git, write, commit, conflict, bin: stubs(dir) };
}

function prePush(s, refs, env = {}, runner = 'vitest') {
  const stdin = refs.map(([local, remote]) => `refs/heads/x ${local} refs/heads/x ${remote}\n`).join('');
  const r = spawnSync('sh', [join(here, 'pre-push.sh'), 'main', runner, '-t', 'test'], {
    cwd: s.repo,
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, ...env },
  });
  const callsFile = join(s.dir, 'nx.calls');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [];
  return { code: r.status, out: r.stdout + r.stderr, calls };
}

const filesArg = (call) =>
  call
    .match(/--files=(\S+)/)?.[1]
    .split(',')
    .sort();

test('a new branch tests the files its commits change', () => {
  const s = scratch();
  s.git('switch', '-qc', 'feat');
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  const r = prePush(s, [[head, zero]]);
  assert.equal(r.code, 0);
  assert.deepEqual(filesArg(r.calls[0]), ['a/new.ts']);
});

test('a push that only merges main tests nothing', () => {
  const s = scratch();
  s.git('switch', '-qc', 'feat');
  const pushed = s.commit('feat', { 'a/new.ts': 'x\n' });
  s.git('switch', '-q', 'main');
  s.commit('main', { 'b/main.ts': 'moved\n' });
  s.git('push', '-q', 'origin', 'main');
  s.git('switch', '-q', 'feat');
  s.git('merge', '-q', '--no-edit', 'main');
  const r = prePush(s, [[s.git('rev-parse', 'HEAD'), pushed]]);
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 0);
  assert.match(r.out, /nothing to test/);
});

test('a conflicted merge tests the files its resolution changed', () => {
  const s = scratch();
  s.git('switch', '-qc', 'feat');
  const pushed = s.commit('feat', { 'a/util.ts': 'feat\n' });
  s.git('switch', '-q', 'main');
  s.commit('main', { 'a/util.ts': 'main\n', 'b/main.ts': 'moved\n' });
  s.git('push', '-q', 'origin', 'main');
  s.git('switch', '-q', 'feat');
  s.conflict();
  s.commit('merge main', { 'a/util.ts': 'both\n' });
  const r = prePush(s, [[s.git('rev-parse', 'HEAD'), pushed]]);
  assert.deepEqual(filesArg(r.calls[0]), ['a/util.ts']);
});

test('a push that restores a file to its base content tests that file', () => {
  const s = scratch();
  s.git('switch', '-qc', 'feat');
  const pushed = s.commit('change', { 'a/util.ts': 'changed\n' });
  const head = s.commit('revert', { 'a/util.ts': 'base\n' });
  const r = prePush(s, [[head, pushed]]);
  assert.deepEqual(filesArg(r.calls[0]), ['a/util.ts']);
});

test('a push that deletes a file the branch added tests that file', () => {
  const s = scratch();
  s.git('switch', '-qc', 'feat');
  const pushed = s.commit('add', { 'a/new.ts': 'x\n' });
  const head = s.commit('delete', { 'a/new.ts': null });
  const r = prePush(s, [[head, pushed]]);
  assert.deepEqual(filesArg(r.calls[0]), ['a/new.ts']);
});

test('a deleted ref tests nothing', () => {
  const s = scratch();
  const r = prePush(s, [[zero, s.git('rev-parse', 'HEAD')]]);
  assert.equal(r.calls.length, 0);
});

test('past the load ceiling, tests are left to CI', () => {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  const r = prePush(s, [[head, zero]], { FAKE_LOAD: '320.00' });
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 0);
  assert.match(r.out, /past the ceiling/);
});

test('timeouts scale with the load, and Vitest gets a hook timeout too', () => {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  assert.match(prePush(s, [[head, zero]]).calls[0], /-- --testTimeout=5000 --hookTimeout=5000$/);
  const busy = scratch();
  const busyHead = busy.commit('feat', { 'a/new.ts': 'x\n' });
  const call = prePush(busy, [[busyHead, zero]], { FAKE_LOAD: '25.00' }).calls[0];
  assert.match(call, /--parallel=1 -- --testTimeout=15000 --hookTimeout=15000$/);
});

test('Jest gets only a test timeout, which covers its hooks', () => {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  assert.match(prePush(s, [[head, zero]], {}, 'jest').calls[0], /-- --testTimeout=5000$/);
});

// The first run fails one test task; the rerun prints the given log.
function rerun(log, runner = 'vitest') {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  const first = join(s.dir, 'first.log');
  writeFileSync(first, '\x1b[31mFailed tasks:\x1b[39m\n\n- a:test\n');
  return prePush(
    s,
    [[head, zero]],
    { NX_FIRST_LOG: first, NX_FIRST_RC: '1', NX_RERUN_LOG: join(here, 'fixtures', log), NX_RERUN_RC: '1' },
    runner
  );
}

test('the rerun runs only the failed project, with 30s timeouts', () => {
  const r = rerun('vitest-timeouts.log');
  assert.match(
    r.calls[1],
    /^run-many -t test -p a --parallel=1 --skip-nx-cache -- --testTimeout=30000 --hookTimeout=30000$/
  );
});

for (const [log, runner, verdict] of [
  ['vitest-timeouts.log', 'vitest', 'push'],
  ['vitest-timeout-and-assertion.log', 'vitest', 'block'],
  ['vitest-hook-timeout.log', 'vitest', 'push'],
  ['vitest-killed-worker.log', 'vitest', 'push'],
  ['jest-timeouts.log', 'jest', 'push'],
  ['jest-timeout-and-assertion.log', 'jest', 'block'],
  ['jest-hook-timeout.log', 'jest', 'push'],
  ['jest-killed-worker.log', 'jest', 'push'],
]) {
  test(`a rerun ending like ${log} ${verdict === 'push' ? 'lets the push through' : 'blocks the push'}`, () => {
    const r = rerun(log, runner);
    assert.equal(r.code, verdict === 'push' ? 0 : 1, r.out);
  });
}

test('a rerun that runs out of memory before reporting lets the push through', () => {
  const s = scratch();
  writeFileSync(
    join(s.dir, 'oom.log'),
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'
  );
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  const first = join(s.dir, 'first.log');
  writeFileSync(first, 'Failed tasks:\n\n- a:test\n');
  const r = prePush(s, [[head, zero]], {
    NX_FIRST_LOG: first,
    NX_FIRST_RC: '1',
    NX_RERUN_LOG: join(s.dir, 'oom.log'),
    NX_RERUN_RC: '1',
  });
  assert.equal(r.code, 0, r.out);
});

test('a rerun that passes lets the push through', () => {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  const first = join(s.dir, 'first.log');
  writeFileSync(first, 'Failed tasks:\n\n- a:test\n');
  const r = prePush(s, [[head, zero]], { NX_FIRST_LOG: first, NX_FIRST_RC: '1', NX_RERUN_RC: '0' });
  assert.equal(r.code, 0);
  assert.match(r.out, /passed only on the serial rerun/);
});

test('a failed build, and the tests it kept from running, block without a rerun', () => {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  const r = prePush(s, [[head, zero]], {
    NX_FIRST_LOG: join(here, 'fixtures', 'nx-failed-build.log'),
    NX_FIRST_RC: '1',
  });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 1);
  assert.match(r.out, /b:test,a:build/);
});

test('owners.mjs names the deepest project that holds each file', () => {
  const out = execFileSync(
    'node',
    [join(here, 'owners.mjs'), join(here, 'fixtures', 'graph.json'), 'a/x.ts', 'a/sub/y.ts', 'README.md', 'a/x.ts'],
    { encoding: 'utf8' }
  ).trim();
  assert.equal(out, 'a,a-sub');
});

function preCommit(s) {
  const r = spawnSync('sh', [join(here, 'pre-commit.sh'), '-t', 'lint,typecheck'], {
    cwd: s.repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` },
  });
  const callsFile = join(s.dir, 'nx.calls');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [];
  return { code: r.status, calls };
}

test('pre-commit checks the projects that own the staged files', () => {
  const s = scratch();
  s.write('a/sub/y.ts', 'x\n');
  s.write('README.md', 'x\n');
  s.git('add', 'a/sub/y.ts', 'README.md');
  const r = preCommit(s);
  assert.equal(r.code, 0);
  assert.equal(r.calls.at(-1), 'run-many -t lint,typecheck -p a-sub');
});

test('pre-commit skips nx when no staged file is in a project', () => {
  const s = scratch();
  s.write('README.md', 'x\n');
  s.git('add', 'README.md');
  assert.ok(!preCommit(s).calls.some((call) => call.startsWith('run-many')));
});

test('pre-commit only formats during a merge', () => {
  const s = scratch();
  s.git('switch', '-qc', 'feat');
  s.commit('feat', { 'a/util.ts': 'feat\n' });
  s.git('switch', '-q', 'main');
  s.commit('main', { 'a/util.ts': 'main\n' });
  s.git('switch', '-q', 'feat');
  s.conflict();
  s.write('a/util.ts', 'both\n');
  s.git('add', 'a/util.ts');
  const r = preCommit(s);
  assert.equal(r.code, 0);
  assert.equal(r.calls.length, 0);
});
