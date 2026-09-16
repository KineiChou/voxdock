# Operations

Use `pnpm voxdock` from the source workspace. `--config FILE` defaults to `./voxdock.config.json`; relative file references and the data directory resolve relative to that configuration file. Commands print JSON where practical. Error output contains stable codes and never includes credential contents.

## Initialize and inspect

`pnpm voxdock init ./instance` requires a new directory. It creates `voxdock.config.json`, a random `control.token`, and `data/`. The token and configuration have mode `0600`; the directory has mode `0700`. Calling and both platforms start disabled. Initialization does not pair accounts, contact services, or make calls.

`pnpm voxdock doctor --config ./instance/voxdock.config.json` validates local configuration, Node 24, the control token, enabled credential file access and permissions, configured target environment values, and Telegram's FFmpeg executable. It never connects to a platform or paid API. Disabled platforms require no credentials. Native and Live readiness remain unverified until the adapters actually report readiness. Add `--online` to also query the running control API; this is an explicit network request.

Account pairing and fixed target binding must be completed using the adapter's supported account workflow before enabling calling. This CLI does not provide a pairing command. Prepare the enabled platform and backend credentials, then explicitly set `calling.enabled` to true when ready.

## Run and control

`pnpm voxdock serve --config ./instance/voxdock.config.json` opens the local SQLite store, recovers interrupted calls, initializes the runtime, and starts the authenticated HTTP service. Readiness comes from the runtime. Recovered requests are cancelled before dialing; calls with recorded external intent remain uncertain. Any recovered call persists a global pause until an operator reconciles and explicitly resumes.

A separate `data/process-lock.sqlite` transaction prevents another CLI service or offline mutation from taking ownership of the same data directory. A process crash releases the SQLite lock; there is no PID file to delete. Store all SQLite files on a local filesystem. Shutdown stops HTTP handling, closes the runtime, then closes the store. HTTP and runtime cleanup have finite deadlines; a timeout reports `shutdown_incomplete`.

- `pnpm voxdock status --config FILE` returns capabilities and current calls. Add a call ID after `status` to inspect that call.
- `pnpm voxdock targets --config FILE` lists active fixed target references.
- `pnpm voxdock pause --config FILE` persists a pause through the control API. Existing calls continue until explicitly ended.
- `pnpm voxdock end CALL_ID --config FILE` requests termination. An accepted request is not proof that the platform has ended the call.

An outbound request requires every identifier and a fixed expiry:

```sh
pnpm voxdock call --config ./instance/voxdock.config.json \
  --target owner-telegram --context-ref example-42 \
  --correlation-ref delivery:example-42 --key delivery-example-42 \
  --expires-at 2026-09-17T09:05:00Z
```

Use an actual future UTC expiry within your configured request TTL. If the outcome is unknown, retry the exact original key and body. Do not generate a fresh key or expiry to retry the same notification. The service checks calling permission, target binding and adapter readiness before any fresh request proceeds.

## Reconcile and resume

Stop the service before local mutation commands. Verify the external platform has actually ended an uncertain call, then run `pnpm voxdock reconcile CALL_ID --confirm-ended --config FILE`. This records `operator_confirmed_ended` and keeps calling paused. It does not contact the platform or settle unknown usage to zero.

`pnpm voxdock resume --config FILE` clears the persisted pause only if configuration enables calling and no active or uncertain calls remain. Restart the service afterward. A configuration-level pause cannot be bypassed by this command.

## Export and retain records

`pnpm voxdock audit export --call CALL_ID --format json --out ./record.json --config FILE` reads an authorized record from the running service. Use `--format html` for a local readable export. Output files must be new and use mode `0600`. HTML escapes transcript and result text and contains no executable scripts. Exports can contain private conversation content; they are not automatically published or automatically removed with the source records.

`pnpm voxdock cleanup --config FILE` applies configured retention to the local store while the service is stopped. Transcript expiry includes copies in delegation fragments. Result summaries expire for terminal records. Minimal call and command identities remain to prevent replay; uncertain calls retain the state needed for reconciliation. Consistent SQLite backups and downstream recipients have separate retention requirements.
