// Prints the nx projects that own the given files, comma-separated, so the
// pre-commit hook checks those projects and not their dependents.
// Usage: node owners.mjs <graph.json> <NUL-separated file list>
import { readFileSync } from 'node:fs';

const [graphFile, listFile] = process.argv.slice(2);
const { nodes } = JSON.parse(readFileSync(graphFile, 'utf8')).graph;
const files = readFileSync(listFile, 'utf8').split('\0').filter(Boolean);
const roots = Object.entries(nodes)
  .map(([name, node]) => ({ name, root: `${node.data.root}/` }))
  .filter(({ root }) => root !== './')
  .sort((a, b) => b.root.length - a.root.length);

const owners = new Set();
for (const file of files) {
  const owner = roots.find(({ root }) => file.startsWith(root));
  if (owner) owners.add(owner.name);
}
console.log([...owners].join(','));
