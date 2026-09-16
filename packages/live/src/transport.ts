import WebSocket from 'ws';
import type { LiveTransport } from './client.js';

/** Creates no connection until LiveClient.start subscribes. Key never enters event payloads. */
export function createOpenAITransport(apiKey: string, safetyIdentifier?: string): LiveTransport {
  if (!apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error('Invalid OpenAI key');
  if (safetyIdentifier !== undefined && (!safetyIdentifier || /[\r\n]/.test(safetyIdentifier))) throw new Error('Invalid safety identifier');
  let socket: WebSocket | undefined;
  return {
    get bufferedAmount() { return socket?.bufferedAmount ?? 0; },
    send(text) {
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Transport is not open');
      socket.send(text);
    },
    terminate() { socket?.terminate(); },
    subscribe(handlers) {
      if (socket) throw new Error('Transport already used');
      socket = new WebSocket('wss://api.openai.com/v1/live/sessions', {
        headers: { Authorization: `Bearer ${apiKey}`, ...(safetyIdentifier ? { 'OpenAI-Safety-Identifier': safetyIdentifier } : {}) },
        maxPayload: 2_000_000,
        handshakeTimeout: 15000,
        perMessageDeflate: false,
      });
      const onMessage = (data: WebSocket.RawData, binary: boolean) => {
        if (binary) { handlers.error(); return; }
        handlers.message(data.toString());
      };
      socket.on('open', handlers.open);
      socket.on('message', onMessage);
      socket.on('close', handlers.close);
      socket.on('error', handlers.error);
      return () => {
        socket!.off('open', handlers.open);
        socket!.off('message', onMessage);
        socket!.off('close', handlers.close);
        socket!.off('error', handlers.error);
        // terminate during handshake may emit an error after listeners are detached.
        socket!.on('error', () => {});
      };
    },
  };
}
