export class TelegramCleanupError extends Error {
  constructor() { super('Telegram cleanup could not be confirmed'); }
}
