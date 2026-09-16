import { readFile } from 'node:fs/promises';
import { authorizeTelegram, connectTelegram, telegramAccountProfile } from '../../packages/telegram/src/account.ts';
import { TelegramDriver } from '../../packages/telegram/src/driver.ts';

const [mode, configPath] = process.argv.slice(2);
if (!['--setup', '--profile', '--call'].includes(mode ?? '') || !configPath) {
  throw new Error('Usage: telegram-account.ts --setup|--profile|--call CONFIG.json; only --call places a call');
}
const config = JSON.parse(await readFile(configPath, 'utf8')) as {
  apiId: number; apiHashFile: string; sessionFile: string; accountId: string; targetId: string;
};
const account = { apiId: config.apiId, apiHash: (await readFile(config.apiHashFile, 'utf8')).trim(), sessionFile: config.sessionFile };

async function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Interactive authorization requires a terminal');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.off('data', input); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const input = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') { cleanup(); reject(new Error('Authorization cancelled')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', input);
  });
}

if (mode === '--setup') {
  const userId = await authorizeTelegram(account, {
    phoneNumber: () => secret('Phone number (hidden): '), phoneCode: () => secret('Login code (hidden): '), password: () => secret('Two-step password (hidden): '),
  });
  console.log(`Session saved with owner-only permissions. Configure accountId=${userId}.`);
} else {
  const client = await connectTelegram(account);
  try {
    const profile = await telegramAccountProfile(client);
    if (mode === '--profile') console.log(`Authorized user ID: ${profile.userId}`);
    else {
      if (profile.userId !== config.accountId) throw new Error('Configured account does not match session');
      const driver = new TelegramDriver(client, config.accountId, config.targetId, {
        onState: (_ref, state) => console.log(`Call state: ${state}`),
        onAudio: () => {}, onAudioReady: () => console.log('Native media ready'),
        onIncoming: () => console.log('Incoming call requires admission'),
      });
      try {
        await driver.dial(config.targetId, AbortSignal.timeout(45000));
        await new Promise(resolve => setTimeout(resolve, 45000));
      } finally { await driver.close(); }
    }
  } finally { await client.disconnect(); }
}
