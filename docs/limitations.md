# Known limitations

VoxDock is experimental software for a single self-hosted operator, one configured business backend and one active call. The web console, CLI and API share the same service and SQLite records. Multi-user tenancy, scoped Agent credentials and MCP are not provided.

## Calls and platforms

| Area | Current boundary |
| --- | --- |
| Telegram | Real account binding and incoming call handshakes have been exercised. Handset audio has not succeeded; complete incoming/outgoing conversations remain unvalidated. |
| WhatsApp | A real outgoing conversation sustained two minutes, including a GPT-5.6 Sol answer. At the configured duration limit, the receiving iPhone displayed “Call failed”; normal handset termination remains unresolved. |
| Incoming WhatsApp calls | Device-qualified LID-to-phone admission is supported in code; successful handset acceptance remains unverified. Unknown or mismatched identities remain rejected. |
| WhatsApp connection setup | Full receiving-account message/call verification and unlink/relink recovery remain unvalidated on real devices. |
| GPT-Live-1 | Real session setup, audio, delegation and final usage have been exercised. Interruption, longer conversations and end-to-end audio quality require further validation. |
| Operations | Real-account backup/restore, version upgrades and 24-hour endurance have not been validated. Automated checks and a successful build do not establish those properties. |

A platform termination acknowledgment is signaling evidence, not proof of the receiving phone's display state. A Live commentary acknowledgment does not prove that speech was heard. Backend acceptance and model output do not prove that an external business action succeeded.

## Recovery and availability

No automatic redial occurs. An uncertain call retains capacity and blocks new calls until its external state is reconciled. Stop the service before offline reconciliation, independently verify termination, then follow [state and recovery](state-and-recovery.md).

WaCalls termination query deadlines do not bound every native cleanup operation. Upstream Pion close/configuration calls are synchronous; behavior during a native cleanup stall remains unvalidated. A process exit, timeout or cancelled HTTP request is not evidence that the handset call ended.

Run one bridge process per local SQLite data directory. A recovered interrupted call persists a pause. Configuration changes and pairing temporarily block admission; uncertain cleanup keeps a recovery pause. Keep platform account sessions, credentials and consistent database backups private.

## Data and deployment

Raw audio is not written to disk. Optional transcripts, backend result text, full audit exports and backups can contain private information. Their retention lifetimes differ; redacted exports omit conversation text but retain timestamps and usage.

The patched WaCalls control service must remain on a trusted private network. Its upstream REST routes have no authentication. Media authentication does not protect those control routes.

The example backend provides simulation or OpenAI text assistance. It has no tools, shell, code execution, project routing or long-term memory. Implement those capabilities and their permissions in your own backend.

Source and local Docker builds are available. There is no prebuilt production image or migration/downgrade compatibility promise. Redistribution of native binaries and container images requires the applicable source and notice inventory described in [third-party notices](../THIRD_PARTY_NOTICES.md).
