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
const app = createExampleBackend({
  databasePath:
    process.env.EXAMPLE_BACKEND_DATABASE ?? "./example-backend.sqlite",
  requestToken: secret("BACKEND_REQUEST_TOKEN"),
  eventSigningKey: secret("BACKEND_EVENT_SIGNING_KEY"),
});
await app.listen({ host: "127.0.0.1", port });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close();
  });
