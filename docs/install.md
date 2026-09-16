# Install and operate

VoxDock is a source alpha for one self-hosted operator. These instructions distinguish a paused local control service from enabling a real platform and paid Live session. Real-call acceptance is still open; see [acceptance](acceptance.md).

## Source service

Use Node 24, pnpm 10.17.1 and a local filesystem for SQLite. Install FFmpeg on `PATH` before using Telegram audio; it converts 48 kHz platform PCM to/from 24 kHz Live PCM. Install dependencies with `pnpm install --frozen-lockfile`, then run `pnpm typecheck` and `pnpm test`.

```sh
pnpm voxdock init ./local
pnpm voxdock doctor --config ./local/voxdock.config.json
pnpm voxdock serve --config ./local/voxdock.config.json
```

`init` creates a configuration, a 0600 control token and a data directory. It does not log in, dial or enable channels. `doctor` is an offline check, not a platform/API connection test. Secret paths resolve relative to the configuration directory. Keep the generated directory and all account sessions outside version control. Stop the service before offline maintenance commands that access its SQLite database.

Useful commands with `--config ./local/voxdock.config.json`:

| Command | Purpose |
| --- | --- |
| `status [CALL_ID]`, `targets` | Inspect the running service |
| `pause` | Block new calls |
| `end CALL_ID` | Request ending one call; inspect its resulting state |
| `resume` | Offline operator action to clear a pause after checking prerequisites |
| `reconcile CALL_ID --confirm-ended` | Offline confirmation after independently verifying a previously uncertain call ended |
| `cleanup` | Offline retention cleanup |
| `audit export --call CALL_ID --format html --out NEW_FILE` | Export call evidence from the running service; JSON is also supported |

An interrupted or uncertain call is not permission to redial. Verify the platform state, follow [recovery](state-and-recovery.md), and resume deliberately. Back up SQLite consistently after stopping the writer; do not copy only a live WAL database's main file. Keep the separate platform account/session data in the backup policy.

## Telegram configuration

Copy fields from [the Telegram example](../config/telegram.example.json) into your initialized configuration. The example keeps `calling.enabled` false. Supply:

- `TELEGRAM_API_ID` and an API-hash secret file for your Telegram application.
- A provisioned session file for the bridge account.
- `TELEGRAM_TARGET_ID`: the stable numeric ID of a different account you control as the call recipient.
- A GPT-Live-1 API key file, the backend URL and distinct backend request/signing secret files.

Use the explicit provisioning utility described in [platforms](platforms.md); service startup never prompts for phone codes. Verify the account and target before enabling calls. `account_ref` and `principal_ref` are local references, not voice authentication. Run your backend independently; the [example backend](backend.md) is a local simulation and binds loopback.

After configuration and backend setup, enable calling in the file, rerun `doctor`, start the service and inspect `status`/`targets`. Availability only establishes loaded/configured components, not a completed phone or Live acceptance test. A real outbound command is explicit:

```sh
pnpm voxdock call --config ./local/voxdock.config.json \
  --target owner-telegram --context-ref your-context-reference \
  --correlation-ref your-request-reference --key your-unique-idempotency-key \
  --expires-at YOUR_UTC_ISO_EXPIRY
```

Use a future UTC expiry within the configured request TTL. Preserve the same key, expiry and payload when retrying the same command; changing them creates a different request. This command can place a real call and incur Live usage once calling is enabled.

## Local Docker build

The Docker definitions are provided for local builds, not as verified production images. The image runs source with `tsx`, pins Node 24.21.0 and pnpm 10.17.1, and installs Debian FFmpeg `7:5.1.9-0+deb12u1`. Package provenance is written to `/app/provenance`. OS transitive packages and base-image tags are not immutable release artifacts; record image digests and audit redistribution before publishing an image.

Initialize `./local` with the source CLI first. For a paused container, replace only its configuration with the container example, retaining its generated token:

```sh
cp config/container.example.json local/voxdock.config.json
export VOXDOCK_UID="$(id -u)" VOXDOCK_GID="$(id -g)"
docker compose config --quiet
docker compose build bridge
docker compose up bridge
```

The service listens inside the container on `0.0.0.0:8787`, while the host publishes only `127.0.0.1:8787`. The control token remains required. The configuration is mounted read-only at `/config`; SQLite data is mounted writable at `/data`. UID/GID settings let the non-root process read the 0600 token and write the existing data directory. Do not mount a source workspace or account secrets unrelated to this service. There is no automatic restart policy that would hide a recovery decision.

For a real container configuration, keep `/data`, the container listen address and relative `/config` secret references. Set an accessible private backend URL; container loopback is not the host's example backend. `TELEGRAM_API_ID` and `TELEGRAM_TARGET_ID` are forwarded from the operator environment. A configured channel may still be unavailable if Linux native loading or authorization fails.

## Optional WaCalls sidecar

WhatsApp uses the same call coordinator as Telegram, with a paired WaCalls account and 16 kHz PCM. The implementation remains experimental until real-call acceptance. Running this sidecar alone does not enable calling.

`Dockerfile.wacalls` builds the pinned upstream plus the [media patch](wacalls-media.md) and its pairing UI from source. It preserves upstream and MLow notices. It is independent of the bridge image. Set up directories and a random shared media secret before selecting the profile:

```sh
mkdir -p local/secrets local/wacalls-data
(umask 077; openssl rand -hex 32 > local/secrets/wacalls-media)
docker compose --profile whatsapp build wacalls
docker compose --profile whatsapp up wacalls
```

The `whatsapp` profile publishes no WaCalls port. Its upstream REST API has no authentication; the new media-token and WebSocket endpoints are authenticated. Use `http://wacalls:8080` only within the trusted Compose network. The same secret must be available to the Node client and WaCalls through their configured files. Do not reuse the control or backend token.

For explicit temporary pairing access, add the loopback-only override:

```sh
docker compose -f compose.yaml -f config/compose.pairing.example.yaml \
  --profile whatsapp up wacalls
```

Open `http://127.0.0.1:8080` locally. On a remote server, use an SSH local port forward to its loopback port; never bind this API publicly. After pairing, stop the override and restart using only `compose.yaml`. Account data persists in `local/wacalls-data`. Do not share QR codes or session files.

Copy the [WhatsApp configuration example](../config/whatsapp.example.json) into the initialized configuration, retaining the generated control token. Set both `account_ref` values to the exact paired session ID; set `WHATSAPP_TARGET_PHONE` to the other account you control. A personal phone JID is also accepted. For Compose, use `http://wacalls:8080`, `/data` and the container listen address. Share the media secret through `secrets/wacalls-media` relative to `/config`, then configure Live and backend credentials. Startup requires the paired account to be open and its initial upstream call list empty. Unknown LID mappings are rejected. A terminate acknowledgment is signaling evidence; it does not prove the handset UI state.

## Distribution and support

These definitions download native dependencies for the operator's local build. NTgCalls is LGPL-3.0-only and its npm artifact's metadata does not constitute a complete source/notice bundle. FFmpeg and transitive native libraries have separate obligations. Do not infer that the root MIT license covers the resulting image. A published binary/image release requires a corresponding-source and notice inventory, immutable dependency/image provenance and applicable license review. Those release gates are not completed here.

When reporting an issue, include the source commit, OS/architecture, Node version, sanitized `doctor` output and the observed call state. Do not attach tokens, account sessions, QR codes, raw audio or private transcripts. See [acceptance](acceptance.md) for the difference between local test coverage and unverified real-world behavior.
