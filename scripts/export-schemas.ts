import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as contracts from '../packages/contracts/src/index.ts';
import { BridgeConfigSchema } from '../packages/config/src/index.ts';

const output = resolve(process.argv[2] ?? 'dist/schemas');
await mkdir(output, { recursive: true });
for (const [name, schema] of Object.entries({ BridgeConfigSchema, ...contracts })) {
  if (!name.endsWith('Schema')) continue;
  const title = name.slice(0, -6);
  await writeFile(resolve(output, `${title}.json`), JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `urn:voxdock:schema:1:${title}`, title, ...schema,
  }, null, 2) + '\n');
}
console.log(`Exported public schemas to ${output}`);
