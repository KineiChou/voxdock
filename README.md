# VoxDock

**Let your agent call you.**

A self-hosted voice bridge in development for **Telegram**, **WhatsApp**, and
**GPT-Live-1**. Connect your own agent backend to receive voice requests and make
event-triggered calls.

> Early development. Native calling is not yet verified. No production release.

## Scope

- One self-hosted operator and one configured backend.
- Telegram through NTgCalls and an MTProto user client.
- WhatsApp through WaCalls, with a server-side audio adapter.
- Versioned HTTP contracts, bounded call duration, and traceable delegation.

Project routing, long-term memory, and business task execution belong to your backend.

## Development

Node.js 24 and pnpm 10 are the target toolchain. Setup instructions will be added
with the first runnable milestone.

See [contributing](CONTRIBUTING.md) for the development workflow.

## License

Original VoxDock code is MIT licensed. Platform libraries retain their own
licenses; dependency notices accompany integrations.
