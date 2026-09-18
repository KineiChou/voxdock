import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export async function smokeMcp() {
  const requests: {
    url: string;
    method: string;
    body: string;
    key: string | undefined;
  }[] = [];
  const now = new Date().toISOString();
  const call = {
    call_id: "call-1",
    target_id: "target-1",
    context_ref: "context-1",
    correlation_ref: "corr-1",
    expires_at: now,
    created_at: now,
    updated_at: now,
    direction: "outbound",
    state: "requested",
    revision: 1,
    audio_ready: false,
    live_ready: false,
  };
  const http = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      url: req.url!,
      method: req.method!,
      body,
      key: req.headers["idempotency-key"] as string | undefined,
    });
    assert.equal(req.headers.authorization, "Bearer synthetic-agent-token");
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/targets")
      res.end(
        JSON.stringify([
          {
            id: "target-1",
            channel: "whatsapp",
            enabled: true,
            private_field: "discard-me",
          },
        ]),
      );
    else if (req.url === "/v1/capabilities")
      res.end(
        JSON.stringify({ calling_enabled: true, max_request_ttl_seconds: 300 }),
      );
    else if (req.url === "/v1/calls/missing") {
      res.statusCode = 403;
      res.end('{"error":"secret-raw-error"}');
    } else if (req.url === "/v1/calls/unknown/end") {
      req.socket.destroy();
    } else {
      if (req.method === "POST") res.statusCode = 202;
      res.end(
        JSON.stringify({
          ...call,
          ...(req.url?.endsWith("/end") ? { state: "ending" } : {}),
        }),
      );
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "voxdock-mcp-"));
  const tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-agent-token\n", { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../bin/voxdock-mcp.mjs", import.meta.url))],
    cwd: tmpdir(),
    env: {
      VOXDOCK_BASE_URL: `http://127.0.0.1:${address.port}`,
      VOXDOCK_AGENT_TOKEN_FILE: tokenFile,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "voxdock-smoke", version: "0.1.0" });
  try {
    await client.connect(transport);
    assert.equal(requests.length, 0, "startup must not contact the bridge");
    const list = await client.listTools();
    assert.equal(list.tools.length, 4);
    assert(
      list.tools.every(
        (tool) => tool.inputSchema.additionalProperties === false,
      ),
    );
    const targets = await client.callTool({
      name: "voxdock_list_targets",
      arguments: {},
    });
    assert.equal(targets.isError, undefined);
    assert(!JSON.stringify(targets).includes("private_field"));
    const count = requests.length;
    const invalid = await client.callTool({
      name: "voxdock_call",
      arguments: { target_id: "target-1", phone: "+123" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, count);
    const input = {
      target_id: "target-1",
      context_ref: "context-1",
      correlation_ref: "corr-1",
      expires_at: now,
      idempotency_key: "same-key",
    };
    for (let index = 0; index < 2; index++)
      assert.equal(
        (await client.callTool({ name: "voxdock_call", arguments: input }))
          .isError,
        undefined,
      );
    const creates = requests.filter((req) => req.url === "/v1/calls");
    assert.equal(creates.length, 2);
    assert.equal(creates[0]!.key, "same-key");
    assert.deepEqual(creates[0], creates[1]);
    assert.equal(
      (
        await client.callTool({
          name: "voxdock_get_call",
          arguments: { call_id: "call-1" },
        })
      ).isError,
      undefined,
    );
    assert.equal(
      (
        await client.callTool({
          name: "voxdock_end_call",
          arguments: { call_id: "call-1" },
        })
      ).isError,
      undefined,
    );
    const denied = await client.callTool({
      name: "voxdock_get_call",
      arguments: { call_id: "missing" },
    });
    assert.equal(denied.isError, true);
    assert.deepEqual(denied.structuredContent, {
      error: { code: "forbidden", http_status: 403 },
    });
    assert(!JSON.stringify(denied).includes("secret-raw-error"));
    const unknown = await client.callTool({
      name: "voxdock_end_call",
      arguments: { call_id: "unknown" },
    });
    assert.equal(unknown.isError, true);
    assert.deepEqual(unknown.structuredContent, {
      error: { code: "outcome_unknown" },
    });
    assert.equal(
      requests.filter((req) => req.url === "/v1/calls/unknown/end").length,
      1,
    );
    assert.equal(stderr, "");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
