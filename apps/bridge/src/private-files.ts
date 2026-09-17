import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function writePrivateFile(filename: string, contents: string): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, filename);
  const directory = openSync(dirname(filename), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
