// Drives pre-push.sh, pre-commit.sh and owners.mjs against scratch repos, with
// nx, gh, uptime and getconf stubbed. The test logs under fixtures/ are real
// Vitest 3.2, Jest 29 and Nx 21 output.
// Usage: node --test tools/hooks/hooks.test.mjs
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  graph) if [ -n "$BAD_GRAPH" ]; then echo '{' >"\${2#--file=}"; else cp "${here}/fixtures/graph.json" "\${2#--file=}"; fi ;;
  affected) cat "$NX_FIRST_LOG" 2>/dev/null; exit "\${NX_FIRST_RC:-0}" ;;
  run-many)
    [ -n "$PROBE" ] && cat $PROBE >"${dir}/probe" 2>/dev/null
    echo "$NX_WORKSPACE_DATA_DIRECTORY $NX_CACHE_DIRECTORY" >"${dir}/nx.env"
    p=$(echo "$*" | sed 's/.* -p \\([^ ]*\\).*/\\1/')
    cat "$NX_RERUN_DIR/$p.log" 2>/dev/null
    exit "$(cat "$NX_RERUN_DIR/$p.rc" 2>/dev/null || echo 0)" ;;
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
const scratchDirs = [];
after(() => scratchDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
  scratchDirs.push(dir);
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

test('at a load up to one per core, the projects keep their own timeouts', () => {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  assert.match(prePush(s, [[head, zero]]).calls[0], /--files=a\/new\.ts$/);
});

test('under load, timeouts scale, and Vitest gets a hook timeout too', () => {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  const call = prePush(s, [[head, zero]], { FAKE_LOAD: '25.00' }).calls[0];
  assert.match(call, /--parallel=1 -- --testTimeout=15000 --hookTimeout=15000$/);
});

test('Jest gets only a test timeout, which covers its hooks', () => {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  assert.match(prePush(s, [[head, zero]], { FAKE_LOAD: '25.00' }, 'jest').calls[0], /-- --testTimeout=15000$/);
});

// The first run fails the test task of each project in `reruns`, and each
// project's rerun prints its log: a fixture name, or text written as is.
function failing(reruns, runner = 'vitest') {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  const dir = join(s.dir, 'reruns');
  execFileSync('mkdir', ['-p', dir]);
  for (const [project, { log, rc = 1 }] of Object.entries(reruns)) {
    const fixture = join(here, 'fixtures', log ?? '');
    writeFileSync(join(dir, `${project}.log`), log && existsSync(fixture) ? readFileSync(fixture) : (log ?? ''));
    writeFileSync(join(dir, `${project}.rc`), String(rc));
  }
  const first = join(s.dir, 'first.log');
  const tasks = Object.keys(reruns).map((project) => `- ${project}:test\n`);
  writeFileSync(first, `\x1b[31mFailed tasks:\x1b[39m\n\n${tasks.join('')}`);
  return prePush(s, [[head, zero]], { NX_FIRST_LOG: first, NX_FIRST_RC: '1', NX_RERUN_DIR: dir }, runner);
}

test('each failed project is rerun on its own, with 120s timeouts', () => {
  const r = failing({ a: { log: 'vitest-timeouts.log' }, b: { log: 'vitest-timeouts.log' } });
  assert.deepEqual(r.calls.slice(1), [
    'run-many -t test -p a --parallel=1 -- --testTimeout=120000 --hookTimeout=120000',
    'run-many -t test -p b --parallel=1 -- --testTimeout=120000 --hookTimeout=120000',
  ]);
  assert.equal(r.code, 0, r.out);
});

for (const [log, runner, verdict] of [
  ['vitest-timeouts.log', 'vitest', 'push'],
  ['vitest-each-timeouts.log', 'vitest', 'push'],
  ['vitest-timeout-and-assertion.log', 'vitest', 'block'],
  ['vitest-hook-timeout.log', 'vitest', 'push'],
  ['vitest-killed-worker.log', 'vitest', 'push'],
  ['vitest-startup-error.log', 'vitest', 'block'],
  ['jest-timeouts.log', 'jest', 'push'],
  ['jest-console-and-timeout.log', 'jest', 'push'],
  ['jest-timeout-and-assertion.log', 'jest', 'block'],
  ['jest-hook-timeout.log', 'jest', 'push'],
  ['jest-killed-worker.log', 'jest', 'push'],
]) {
  test(`a rerun ending like ${log} ${verdict === 'push' ? 'lets the push through' : 'blocks the push'}`, () => {
    const r = failing({ a: { log } }, runner);
    assert.equal(r.code, verdict === 'push' ? 0 : 1, r.out);
  });
}

test('a rerun that runs out of memory before reporting lets the push through', () => {
  const log = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n';
  assert.equal(failing({ a: { log } }).code, 0);
});

test('a rerun that passes lets the push through', () => {
  const r = failing({ a: { rc: 0 } });
  assert.equal(r.code, 0);
  assert.match(r.out, /passed only on the serial rerun/);
});

test('one project timing out does not cover another that failed without a header', () => {
  const r = failing({ a: { log: 'vitest-timeouts.log' }, b: { log: 'vitest-startup-error.log' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /b failed, blocking/);
});

test('a dependency task that fails in the rerun blocks, even beside a timeout', () => {
  const timeouts = readFileSync(join(here, 'fixtures', 'vitest-timeouts.log'), 'utf8');
  const log = `${timeouts}\nFailed tasks:\n\n- core:generate-sdk-info\n`;
  assert.equal(failing({ a: { log } }).code, 1);
});

test('a first run that fails before listing any task blocks without a rerun', () => {
  const s = scratch();
  const head = s.commit('feat', { 'a/new.ts': 'x\n' });
  const first = join(s.dir, 'first.log');
  writeFileSync(first, ' NX   Could not create the project graph\n');
  const r = prePush(s, [[head, zero]], { NX_FIRST_LOG: first, NX_FIRST_RC: '1' });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 1);
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

test('owners.mjs names the deepest project that holds each file, from a NUL list', () => {
  const list = join(mkdtempSync(join(tmpdir(), 'hooks-')), 'staged');
  scratchDirs.push(dirname(list));
  writeFileSync(list, ['a/x.ts', 'a/sub/y.ts', 'README.md', 'a/x.ts'].join('\0') + '\0');
  const out = execFileSync('node', [join(here, 'owners.mjs'), join(here, 'fixtures', 'graph.json'), list], {
    encoding: 'utf8',
  });
  assert.equal(out.trim(), 'a,a-sub');
});

function preCommit(s, env = {}) {
  const r = spawnSync('sh', [join(here, 'pre-commit.sh'), '-t', 'lint,typecheck'], {
    cwd: s.repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, ...env },
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

test('pre-commit checks the staged content, not unstaged edits or untracked files', () => {
  const s = scratch();
  s.write('a/sub/y.ts', 'staged\n');
  s.git('add', 'a/sub/y.ts');
  s.write('a/sub/y.ts', 'unstaged\n');
  s.write('a/sub/untracked.ts', 'untracked\n');
  const r = preCommit(s, { PROBE: 'a/sub/y.ts a/sub/untracked.ts' });
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(s.dir, 'probe'), 'utf8'), 'staged\n');
});

test('pre-commit checks the project a staged deletion leaves behind', () => {
  const s = scratch();
  s.commit('add', { 'a/sub/gone.ts': 'x\n' });
  s.git('rm', '-q', 'a/sub/gone.ts');
  assert.equal(preCommit(s).calls.at(-1), 'run-many -t lint,typecheck -p a-sub');
});

test('pre-commit checks both projects of a staged move', () => {
  const s = scratch();
  s.commit('add', { 'a/sub/moved.ts': 'x\n' });
  s.git('mv', 'a/sub/moved.ts', 'a/moved.ts');
  assert.equal(preCommit(s).calls.at(-1), 'run-many -t lint,typecheck -p a,a-sub');
});

test('pre-commit fails when the project lookup fails', () => {
  const s = scratch();
  s.write('a/sub/y.ts', 'x\n');
  s.git('add', 'a/sub/y.ts');
  const r = preCommit(s, { BAD_GRAPH: '1' });
  assert.notEqual(r.code, 0);
  assert.ok(!r.calls.some((call) => call.startsWith('run-many')));
});

test('a push that moves a file between projects tests both paths', () => {
  const s = scratch();
  s.git('switch', '-qc', 'feat');
  s.git('mv', 'a/util.ts', 'b/util.ts');
  s.git('commit', '-qm', 'move');
  const r = prePush(s, [[s.git('rev-parse', 'HEAD'), zero]]);
  assert.deepEqual(filesArg(r.calls[0]), ['a/util.ts', 'b/util.ts']);
});

test('an app error that says it timed out is a real failure', () => {
  const log =
    ' FAIL  x.test.ts > calls the node\nError: RPC request timed out in 2000ms\n\n      Tests  1 failed (1)\n';
  assert.equal(failing({ a: { log } }).code, 1);
});

// A workspace package linked from node_modules, as Bun and Yarn install them.
function withWorkspaceLink(s) {
  s.commit('core', { 'core/index.ts': 'committed\n' });
  execFileSync('mkdir', ['-p', join(s.repo, 'node_modules/@x')]);
  execFileSync('ln', ['-s', '../../core', join(s.repo, 'node_modules/@x/core')]);
  execFileSync('mkdir', ['-p', join(s.repo, 'node_modules/dep')]);
  writeFileSync(join(s.repo, 'node_modules/dep/index.js'), 'dep\n');
}

test('pre-commit resolves workspace packages to their staged copy', () => {
  const s = scratch();
  withWorkspaceLink(s);
  s.write('core/index.ts', 'staged\n');
  s.git('add', 'core/index.ts');
  s.write('core/index.ts', 'unstaged\n');
  s.write('a/sub/y.ts', 'x\n');
  s.git('add', 'a/sub/y.ts');
  const r = preCommit(s, { PROBE: 'node_modules/@x/core/index.ts node_modules/dep/index.js' });
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(s.dir, 'probe'), 'utf8'), 'staged\ndep\n');
});

test('pre-commit keeps Nx workspace data and cache in the checkout, so the cache can hit', () => {
  const s = scratch();
  s.write('a/sub/y.ts', 'x\n');
  s.git('add', 'a/sub/y.ts');
  preCommit(s);
  const [data, cache] = readFileSync(join(s.dir, 'nx.env'), 'utf8').trim().split(' ');
  assert.equal(data, join(realpathSync(s.repo), '.nx/workspace-data/pre-commit'));
  assert.equal(cache, join(realpathSync(s.repo), '.nx/cache'));
});

test('pre-commit fails when the staged tree cannot be copied', () => {
  const s = scratch();
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = join(s.dir, 'failing-git');
  execFileSync('mkdir', ['-p', bin]);
  // Writes the tree's root, as a copy that runs out of space would, then fails.
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = checkout-index ]; then mkdir -p "\${3#--prefix=}"; exit 1; fi\nexec "${real}" "$@"\n`
  );
  chmodSync(join(bin, 'git'), 0o755);
  s.write('a/sub/y.ts', 'x\n');
  s.git('add', 'a/sub/y.ts');
  const r = preCommit(s, { PATH: `${bin}:${s.bin}:${process.env.PATH}` });
  assert.notEqual(r.code, 0);
  assert.ok(!r.calls.some((call) => call.startsWith('run-many')));
});

test('pre-commit fails when the dependencies cannot be linked in', () => {
  const s = scratch();
  withWorkspaceLink(s);
  // A tracked file inside node_modules collides with the link of the same name.
  writeFileSync(join(s.repo, 'node_modules/dep/index.js'), 'tracked\n');
  s.git('add', '-f', 'node_modules/dep/index.js');
  s.write('a/sub/y.ts', 'x\n');
  s.git('add', 'a/sub/y.ts');
  const r = preCommit(s);
  assert.notEqual(r.code, 0);
  assert.ok(!r.calls.some((call) => call.startsWith('run-many')));
});
