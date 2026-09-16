import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ChannelSchema, RefSchema } from "@voxdock/contracts";

const object = { additionalProperties: false } as const;
const path = Type.String({ minLength: 1, maxLength: 4096 });
const env = Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" });
const seconds = (value: number, maximum = 86400) =>
  Type.Integer({ minimum: 1, maximum, default: value });
const disabled = Type.Object(
  { enabled: Type.Literal(false, { default: false }) },
  object,
);
const telegram = Type.Object(
  {
    enabled: Type.Literal(true),
    account_ref: RefSchema,
    api_id_env: env,
    api_hash_file: path,
    session_file: path,
  },
  object,
);
const whatsapp = Type.Object(
  {
    enabled: Type.Literal(true),
    account_ref: RefSchema,
    endpoint: Type.String({ pattern: "^https?://" }),
    media_token_file: path,
  },
  object,
);
export const BridgeConfigSchema = Type.Object(
  {
    schema_version: Type.Literal(1, { default: 1 }),
    service: Type.Object(
      {
        listen: Type.String({ default: "127.0.0.1:8787" }),
        data_dir: Type.String({ minLength: 1, default: "./data" }),
      },
      { ...object, default: {} },
    ),
    security: Type.Object(
      { control_token_file: Type.Optional(path) },
      { ...object, default: {} },
    ),
    calling: Type.Object(
      {
        enabled: Type.Boolean({ default: false }),
        max_concurrent_calls: Type.Literal(1, { default: 1 }),
        max_call_seconds: seconds(600, 3600),
        daily_live_seconds: seconds(1200),
        ring_timeout_seconds: seconds(30, 120),
        max_request_ttl_seconds: seconds(300, 3600),
        redial_attempts: Type.Literal(0, { default: 0 }),
      },
      { ...object, default: {} },
    ),
    channels: Type.Object(
      {
        telegram: Type.Union([disabled, telegram], {
          default: { enabled: false },
        }),
        whatsapp: Type.Union([disabled, whatsapp], {
          default: { enabled: false },
        }),
      },
      { ...object, default: {} },
    ),
    targets: Type.Array(
      Type.Object(
        {
          id: RefSchema,
          channel: ChannelSchema,
          account_ref: RefSchema,
          peer_id_env: env,
          principal_ref: RefSchema,
          enabled: Type.Boolean({ default: true }),
        },
        object,
      ),
      { default: [], maxItems: 2 },
    ),
    live: Type.Object(
      {
        model: Type.Literal("gpt-live-1", { default: "gpt-live-1" }),
        api_key_file: Type.Optional(path),
        voice: Type.String({ minLength: 1, default: "marin" }),
        language: Type.String({ minLength: 2, default: "en" }),
        delegation: Type.Literal("client", { default: "client" }),
        store: Type.Literal(false, { default: false }),
        sample_rate_hz: Type.Object(
          {
            telegram: Type.Literal(24000, { default: 24000 }),
            whatsapp: Type.Literal(16000, { default: 16000 }),
          },
          { ...object, default: {} },
        ),
      },
      { ...object, default: {} },
    ),
    backend: Type.Optional(
      Type.Object(
        {
          id: RefSchema,
          base_url: Type.String({ pattern: "^https?://" }),
          request_token_file: path,
          event_signing_key_file: path,
          ack_timeout_ms: Type.Integer({
            minimum: 100,
            maximum: 30000,
            default: 3000,
          }),
        },
        object,
      ),
    ),
    records: Type.Object(
      {
        raw_audio: Type.Literal(false, { default: false }),
        transcript_retention_days: Type.Integer({
          minimum: 0,
          maximum: 30,
          default: 7,
        }),
        metadata_retention_days: Type.Integer({
          minimum: 1,
          maximum: 365,
          default: 30,
        }),
      },
      { ...object, default: {} },
    ),
    events: Type.Object(
      {
        retry_deadline_hours: Type.Integer({
          minimum: 1,
          maximum: 168,
          default: 24,
        }),
      },
      { ...object, default: {} },
    ),
    logging: Type.Object(
      {
        level: Type.Union(
          (["debug", "info", "warn", "error", "silent"] as const).map((level) =>
            Type.Literal(level),
          ),
          { default: "info" },
        ),
      },
      { ...object, default: {} },
    ),
    timezone: Type.String({ minLength: 1, default: "UTC" }),
  },
  object,
);
export type BridgeConfig = Static<typeof BridgeConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Validate references only; never read credential files or environment values. */
export function parseConfig(input: unknown): BridgeConfig {
  const value = Value.Default(BridgeConfigSchema, structuredClone(input));
  if (!Value.Check(BridgeConfigSchema, value)) {
    const paths = [...Value.Errors(BridgeConfigSchema, value)].map(
      (error) => error.path || "/",
    );
    throw new ConfigError(
      `Invalid configuration at ${[...new Set(paths)].join(", ")}`,
    );
  }
  const config = value;
  const ids = new Set<string>();
  const channels = new Set<string>();
  for (const target of config.targets) {
    if (ids.has(target.id)) throw new ConfigError("Target IDs must be unique");
    if (channels.has(target.channel))
      throw new ConfigError("Only one target per channel is supported");
    ids.add(target.id);
    channels.add(target.channel);
    const channel = config.channels[target.channel];
    if (!channel.enabled || channel.account_ref !== target.account_ref)
      throw new ConfigError(
        "Targets must reference an enabled channel and its configured account",
      );
  }
  if (config.calling.ring_timeout_seconds > config.calling.max_call_seconds)
    throw new ConfigError("Ring timeout exceeds maximum call duration");
  if (
    config.calling.enabled &&
    (!config.security.control_token_file ||
      !config.live.api_key_file ||
      !config.backend ||
      !config.targets.some((target) => target.enabled))
  ) {
    throw new ConfigError(
      "Calling requires a control token reference, Live key reference, backend and enabled target",
    );
  }
  if (!/^([^:]+|\[[0-9a-fA-F:]+\]):\d+$/.test(config.service.listen))
    throw new ConfigError("Invalid listen address");
  const port = Number(
    config.service.listen.slice(config.service.listen.lastIndexOf(":") + 1),
  );
  if (port < 1 || port > 65535) throw new ConfigError("Invalid listen port");
  const host = config.service.listen.slice(
    0,
    config.service.listen.lastIndexOf(":"),
  );
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(host) &&
    !config.security.control_token_file
  )
    throw new ConfigError(
      "Non-loopback listeners require a control token reference",
    );
  for (const endpoint of [
    config.backend?.base_url,
    config.channels.whatsapp.enabled
      ? config.channels.whatsapp.endpoint
      : undefined,
  ]) {
    if (!endpoint) continue;
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new ConfigError("Invalid service endpoint");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ConfigError(
        "Service endpoints must be HTTP(S) without credentials, query or fragment",
      );
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: config.timezone });
  } catch {
    throw new ConfigError("Invalid timezone");
  }
  return config;
}
