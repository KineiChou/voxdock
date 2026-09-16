import { readFileSync } from "node:fs";
import { createExampleBackend } from "./server.js";
function secret(name: string): string {
  const file = process.env[`${name}_FILE`];
  const value = file ? readFileSync(file, "utf8").trim() : process.env[name];
  if (!value) throw new Error(`Missing ${name} configuration`);
  return value;
}
const port = Number(process.env.EXAMPLE_BACKEND_PORT ?? "8090");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid example backend port");
process.umask(0o077);
const bridgeBaseUrlFile = process.env.EXAMPLE_BRIDGE_BASE_URL_FILE;
const bridgeBaseUrl = bridgeBaseUrlFile
  ? readFileSync(bridgeBaseUrlFile, "utf8").trim()
  : process.env.EXAMPLE_BRIDGE_BASE_URL;
const controlTokenFile = process.env.VOXDOCK_CONTROL_TOKEN_FILE;
if (bridgeBaseUrl && !controlTokenFile)
  throw new Error("Missing callback control-token file configuration");
const mode = process.env.EXAMPLE_BACKEND_MODE ?? "simulation";
if (!["simulation", "openai"].includes(mode)) throw new Error("Invalid example backend mode");
const app = createExampleBackend({
  language: process.env.EXAMPLE_BACKEND_LANGUAGE ?? "en",
  ...(mode === "openai" ? { openai: { apiKey: secret("OPENAI_API_KEY"), model: process.env.OPENAI_MODEL ?? "gpt-5.6-sol" } } : {}),
  databasePath:
    process.env.EXAMPLE_BACKEND_DATABASE ?? "./example-backend.sqlite",
  requestToken: secret("BACKEND_REQUEST_TOKEN"),
  eventSigningKey: secret("BACKEND_EVENT_SIGNING_KEY"),
  ...(bridgeBaseUrl && controlTokenFile
    ? {
        callbacks: {
          bridgeBaseUrl,
          controlToken: readFileSync(controlTokenFile, "utf8").trim(),
        },
      }
    : {}),
});
await app.listen({ host: process.env.EXAMPLE_BACKEND_HOST ?? "127.0.0.1", port });
const timer = bridgeBaseUrl
  ? setInterval(() => {
      void app.deliverCallbacks().catch(() => {});
    }, 1000)
  : undefined;
if (bridgeBaseUrl) void app.deliverCallbacks().catch(() => {});
const modelTimer = mode === "openai" ? setInterval(() => { void app.runModelWork().catch(() => {}); }, 250) : undefined;
if (mode === "openai") void app.runModelWork().catch(() => {});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    clearInterval(timer);
    clearInterval(modelTimer);
    void app.close();
  });
