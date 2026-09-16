import { Api, type TelegramClient } from 'teleproto';
import bigInt from 'big-integer';
import type { TelegramSignalTransport } from './signaling.ts';

export function telegramSignalTransport(client: Pick<TelegramClient, 'invoke'>): TelegramSignalTransport {
  return {
    async send(callId, accessHash, data) {
      await client.invoke(new Api.phone.SendSignalingData({
        peer: new Api.InputPhoneCall({ id: bigInt(callId.toString()), accessHash: bigInt(accessHash.toString()) }),
        data,
      }));
    },
  };
}
