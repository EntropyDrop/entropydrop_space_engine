import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  renderAgentApiReference,
  renderApiReferenceMarkdown
} from '../src/contraption/ScriptApiContract.ts';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const generatedDir = fileURLToPath(new URL('../docs/generated/', import.meta.url));
const outputs = new Map([
  [
    `${generatedDir}api-v2.md`,
    renderApiReferenceMarkdown()
  ],
  [
    `${generatedDir}agent-api-v2.md`,
    `# Space Script API V2 — Agent Reference\n\n<!-- GENERATED from src/contraption/ScriptApiContract.ts. Do not edit by hand. -->\n\n${renderAgentApiReference()}\n`
  ]
]);

const checkOnly = process.argv.includes('--check');
if (!checkOnly) await mkdir(generatedDir, { recursive: true });

for (const [path, expected] of outputs) {
  const relativePath = path.slice(appRoot.length);
  if (checkOnly) {
    let actual = '';
    try {
      actual = await readFile(path, 'utf8');
    } catch {
      throw new Error(`${relativePath} is missing; run npm run docs:generate`);
    }
    if (actual !== expected) {
      throw new Error(`${relativePath} is stale; run npm run docs:generate`);
    }
    console.log(`API docs current: ${relativePath}`);
  } else {
    await writeFile(path, expected, 'utf8');
    console.log(`Generated ${relativePath}`);
  }
}
