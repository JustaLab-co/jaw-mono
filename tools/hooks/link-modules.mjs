// Links the installed dependencies into a copy of the repo. Each entry of a
// node_modules folder is linked on its own, and one that links to a workspace
// package points at that package's copy, so imports between packages read the
// copied source.
// Usage: node link-modules.mjs <repo root> <copy root> <file listing node_modules folders>
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const [root, copy, listFile] = process.argv.slice(2);
const realRoot = realpathSync(root);
const folders = readFileSync(listFile, 'utf8').split('\n').filter(Boolean);

function workspacePath(source) {
  let real;
  try {
    real = realpathSync(source);
  } catch {
    return null;
  }
  const path = relative(realRoot, real);
  return path.startsWith('..') || path.split(sep).includes('node_modules') ? null : path;
}

function link(source, target) {
  const path = lstatSync(source).isSymbolicLink() ? workspacePath(source) : null;
  symlinkSync(path === null ? source : join(copy, path), target);
}

for (const folder of folders) {
  const into = join(copy, relative(root, folder));
  mkdirSync(into, { recursive: true });
  for (const name of readdirSync(folder)) {
    const source = join(folder, name);
    if (!name.startsWith('@') || !lstatSync(source).isDirectory()) {
      link(source, join(into, name));
      continue;
    }
    mkdirSync(join(into, name), { recursive: true });
    for (const scoped of readdirSync(source)) link(join(source, scoped), join(into, name, scoped));
  }
}
