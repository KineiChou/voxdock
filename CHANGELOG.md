# Changelog

## 0.1.0

Initial experimental source release for one self-hosted operator and one active call.

- Telegram integration through teleproto and an isolated NTgCalls worker; WhatsApp integration through a private, patched WaCalls sidecar.
- Continuous GPT-Live-1 audio with configurable voice, conversation instructions and either client-managed or OpenAI Responses delegation; optional web search in Responses mode.
- HTTP backend context, durable delegation receipts, signed call events and result callbacks. An independent example supports simulation or OpenAI text assistance.
- Web console, CLI and HTTP API for account connections, receiving-account verification, managed settings, call controls and audit exports.
- SQLite admission and event records, idempotent commands, bounded call limits, retention and explicit recovery for uncertain outcomes.
- Source installation and local Docker/Compose build definitions. No prebuilt binary or container image is included.

Review [known limitations](docs/limitations.md), [installation and recovery guidance](docs/install.md), and [third-party notices](THIRD_PARTY_NOTICES.md) before use or redistribution. This release does not claim complete handset, restore or endurance validation.
