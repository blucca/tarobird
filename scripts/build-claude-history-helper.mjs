import { build } from 'esbuild';
import { createRequire, builtinModules } from 'node:module';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildClaudeHistoryHelper({ directory = root, output = path.join(directory, 'dist/src/codex/claude-history-native-helper.js'), notices = path.join(directory, 'dist/licenses/claude-agent-sdk') } = {}) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const require = createRequire(path.join(directory, 'package.json'));
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkDirectory = path.dirname(sdkEntry);
  const sdk = JSON.parse(await readFile(path.join(sdkDirectory, 'package.json'), 'utf8'));
  if (manifest.devDependencies?.[sdk.name] !== sdk.version || manifest.dependencies?.[sdk.name]) throw new Error('Claude history SDK must match its exact build-only dependency pin');
  const result = await build({ absWorkingDir: directory, entryPoints: ['src/codex/claude-history-native-helper.ts'], outfile: output, bundle: true, platform: 'node', target: 'node24', format: 'esm', legalComments: 'inline', metafile: true,
    // Resolve the official root export once. Never bundle its optional CLI.
    plugins: [{ name: 'claude-history-sdk-root', setup(build) {
      // A stable virtual source name also keeps builder paths out of the bundle.
      build.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({ path: '@anthropic-ai/claude-agent-sdk', namespace: 'claude-history-sdk' }));
      build.onLoad({ filter: /.*/, namespace: 'claude-history-sdk' }, async () => ({ contents: await readFile(sdkEntry, 'utf8'), loader: 'js', resolveDir: sdkDirectory }));
    } }] });
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
  if (Object.values(result.metafile.outputs).flatMap(value => value.imports).some(value => !value.external || !builtins.has(value.path.replace(/^node:/, '')))
    || Object.keys(result.metafile.inputs).some(file => /claude-agent-sdk-(?:darwin|win32|linux)/.test(file))) throw new Error('Claude history helper must contain only the SDK JavaScript and Node builtins');
  await mkdir(notices, { recursive: true });
  for (const name of ['LICENSE.md', 'README.md']) await cp(path.join(sdkDirectory, name), path.join(notices, name));
  await writeFile(path.join(notices, 'component.json'), JSON.stringify({ name: sdk.name, version: sdk.version, license: sdk.license, source: sdk.homepage }, null, 2) + '\n');
  return result;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await buildClaudeHistoryHelper();
