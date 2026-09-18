# VoxDock documentation

## Set up and operate

- [Installation](install.md): prerequisites, source service, Docker, WaCalls, backup and upgrades.
- [Configuration](configuration.md): Live, voice, delegation mode, backend and calling settings.
- [Operator console](console.md): login, account linking, receiving-account verification and managed settings.
- [Operations](operations.md): CLI commands, call controls, audit exports and retention.
- [State and recovery](state-and-recovery.md): durable identities, uncertain outcomes and safe resumption.
- [Known limitations](limitations.md): current scope, platform issues and validation boundaries.

## Integrate your backend

- [Agent integration](agent-integration.md): scoped credentials, source-installed MCP, Codex/Claude setup and call semantics.
- [Control API](api.md): authentication, call requests and result callbacks.
- [Backend integration](backend.md): context, delegation receipts, signed events and the independent simulation/OpenAI example.
- [Contract schemas](../packages/contracts/src/index.ts): request, response and event contracts. Export JSON with `pnpm schemas` to `dist/schemas/`.

## Understand the system

- [Architecture diagram](assets/architecture.svg): components, process boundaries and data flow.
- [Call runtime](runtime.md): lifecycle coordination, native workers and platform readiness.
- [Live and audio](live.md): primary WebSocket, continuous PCM and client delegation.
- [Platforms](platforms.md): Telegram and WhatsApp adapters and dependencies.
- [Connection management](connection-management.md): shared setup APIs and CLI.
- [WhatsApp target verification](whatsapp-target-pairing.md): receiving-account verification and confirmation.
- [WaCalls media patch](wacalls-media.md) and [Node media client](whatsapp-media-client.md).
- [Console account](console-account.md) and [conversation records](console-conversation.md).

The architecture SVG has a dependency-free [source generator](assets/architecture.mjs). Regenerate it from the repository root with `node docs/assets/architecture.mjs`.

## Contribute and distribute

- [Contributing](../CONTRIBUTING.md)
- [MIT license](../LICENSE) and [third-party notices](../THIRD_PARTY_NOTICES.md)

Business execution, user permissions, project routing and long-term memory belong to the connected backend. VoxDock owns call transport, conversation delivery and the associated records.
