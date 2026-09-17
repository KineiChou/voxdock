import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const prefix = 'scrypt$16384$8$1$';
const format = /^scrypt\$16384\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const derive = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error);
    else resolve(key);
  });
});

export function isConsolePasswordHash(value: string): boolean {
  return format.test(value);
}

export async function hashConsolePassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new Error('invalid_console_password_length');
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${prefix}${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyConsolePassword(password: string, encoded: string): Promise<boolean> {
  const match = format.exec(encoded);
  if (!match || password.length < 12 || password.length > 256) return false;
  const actual = await derive(password, Buffer.from(match[1]!, 'hex'));
  return timingSafeEqual(actual, Buffer.from(match[2]!, 'hex'));
}
