# Third-party components

VoxDock's root license covers its original code, not third-party components. This inventory records selected integration dependencies; release packaging must retain upstream license texts and audit transitive dependencies and native bundled libraries.

| Component | Selected revision | Declared license / attribution |
| --- | --- | --- |
| [NTgCalls](https://github.com/pytgcalls/ntgcalls) | npm 3.0.0-rc03 | LGPL-3.0-only in JavaScript and native package metadata; native libraries require their own distribution review |
| [teleproto](https://github.com/sanyok12345/teleproto) | npm 1.229.0 | MIT; independently developed GramJS fork, retain package LICENSE when distributing |
| [WaCalls](https://github.com/JotaDev66/WaCalls) | edeb31f0427aba896639db503153b777a405eccf | MIT, Copyright (c) 2026 jotadev66 |
| WaCalls vendored MLow | as above, `internal/voip/media/mlow` | MIT, Copyright 2026 Rajeh Taher; upstream README credits purpshell/meowcaller and reference whatsapp-rust implementation |
| [Mantine](https://github.com/mantinedev/mantine) | 9.6.1 | MIT; UI components and charts, retain distributed license notices |
| [node-qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT, Copyright (c) 2012 Ryan Day; local rendering of WhatsApp pairing codes, retain package license |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | `@modelcontextprotocol/server`, `client` and `core` 2.0.0 | Package metadata declares MIT; bundled LICENSE describes the MIT/Apache-2.0 transition and preserves MIT for contributions without relicensing consent. Retain the complete applicable upstream license and notices. |
| [Zod](https://github.com/colinhacks/zod) | 4.6.5 | MIT, Copyright (c) 2025 Colin McDonnell |
| [React](https://github.com/facebook/react) | 19.3.0 | MIT; frontend runtime |
| [Recharts](https://github.com/recharts/recharts) | 3.10.1 | MIT; chart rendering through Mantine |
| [Tabler Icons](https://github.com/tabler/tabler-icons) | 3.46.0 | MIT; interface icons |

The MCP SDK bundled license also identifies non-specification documentation as CC-BY-4.0. Preserve that distinction if redistributing upstream documentation.

The console also uses Vite, React Router and TanStack Query. Fastify plugins provide static assets, secure sessions and rate limiting. The lockfile records the complete installed versions; this selected inventory is not a full transitive license manifest.

WaCalls is run as a separate process and its source is not vendored here. Its `go.mod` pins whatsmeow, Pion WebRTC, modernc SQLite and other separately licensed dependencies. Its root MIT license does not replace those licenses. NTgCalls is loaded through its official Node binding; MIT licensing of VoxDock does not remove LGPL obligations when distributing the binding or linked native binaries.

No permission to use Telegram or WhatsApp services follows from these source licenses. Platform account/API conditions are separate from software distribution permissions.
