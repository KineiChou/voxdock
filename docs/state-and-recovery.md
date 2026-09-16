# Durable call state

The core package uses a single SQLite database with WAL, `synchronous=FULL`, foreign keys, immediate write transactions, and a database-enforced single active call. Run on a local filesystem. Use SQLite's backup API or stop all writers before copying database files; copying only a live WAL database file is not a backup.

A call, its command identity, and its first event commit together before any platform operation. The authenticated client and idempotency key identify a command. Equal bodies return the original call even after configuration changes or expiry; different bodies conflict. Inbound and outbound requests reserve the same capacity. Record `dialing` before external dial intent. No transaction can make SQLite and a remote platform atomic.

Recovery cancels `requested` calls, which have no recorded external intent. Other unfinished calls become `uncertain` and keep capacity reserved until an operator or adapter confirms termination. Recovery never redials or recreates media. Ended calls cannot return to connected. Readiness is cleared during ending, ended, and uncertain states.

State changes append revisioned events in the same transaction. Outbox attempts reuse event IDs, back off up to one hour, and stop after the configured deadline. Delivery failures never create calls. The caller implements authenticated HTTP delivery and serializes its outbox worker; this package does not run network workers or sign requests.

Delegations are bound to a durable call and accept increasing context revisions. Equal revision with changed content conflicts. Results require an existing delegation on the stated call, a unique result ID, and increasing result revisions. Late results remain on the original call and are marked not played. `eligible` is only an instantaneous playback decision; it is not proof of speech. Replayed results are never eligible. A sender must recheck the active call and current revision immediately before handing content to Live.

Usage reserves the maximum configured duration before a Live session starts. It counts the full reservation against the local calendar day at reservation time. Unknown final usage keeps this conservative hold; factual final seconds replace it, including an overrun. This is an application duration budget, not a provider account spending limit. It does not split sessions at midnight, meter price or tokens, or enforce media timers. Use a fixed timezone for a database; changing it requires an explicit accounting migration.

Retention deletes transcript fragments independently of call state. Event pruning removes only a contiguous acknowledged or failed prefix belonging to ended calls; older cursors return `cursor_expired`. Minimal call and command tombstones remain for deduplication. Expired transcript text is also removed from delegation fragments. Terminal result summaries and evidence URLs are redacted after metadata expiry. Hashes remain for conflict detection. `persistTranscripts: false` stores delegation metadata and hashes without fragments, while returning the supplied in-memory payload for dispatch. Audit records distinguish available, empty, disabled and expired transcripts. These are logical retention rules; backups and other recipients have independent retention. The store does not load credentials or environment values, and accepts no audio.

Tests use temporary databases and an injected clock, reopen the store, compete through separate connections, and inject an event-write failure. They do not contact platforms or paid services.

## Core API

- `new CallStore(filename, { now?, persistTranscripts? })`, `close()`.
- `createCall(clientId, key, request, { enabled, allowedTargets, maxTtlSeconds, direction? })`, `getCall(id)`, `listCalls()`, `transition(id, state, patch?)`, `recover()`.
- `events(after?, limit?)`, `pendingEvents(limit?)`, `acknowledgeEvent(id)`, `retryEvent(id, { deadlineHours? }?)`.
- `recordDelegation(payload)`, `recordResult(payload)`, `appendTranscript(callId, fragment)`, `getRecord(callId)`.
- `reserveUsage(callId, { dailySeconds, maxSeconds, timeZone })`, `settleUsage(callId, seconds?)`.
- `prune({ metadataBefore, transcriptsBefore })`, `setPaused(boolean)`, `isPaused(defaultPaused)`. Pause settings survive restart; the controller must apply the pause gate to fresh calls.

Domain failures expose a stable `DomainError.code` and HTTP `statusCode`; errors do not include private payload values.
