import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ControlClient,
  ControlError,
  callInput,
  callIdInput,
} from "@voxdock/control-client";

export function createMcpServer(client: ControlClient) {
  const server = new McpServer(
    { name: "voxdock", version: "0.1.0" },
    {
      instructions:
        "VoxDock tools control real platform phone calls. Call only with explicit user authorization to the bound target. HTTP acceptance is not a connection or proof the recipient heard anything. On outcome_unknown, inspect known call status; retry creation only with the identical idempotency_key and identical body. Never automatically redial or generate a new key to resolve uncertainty. Context references must already exist in the configured business backend; these tools do not create context or read transcripts.",
    },
  );
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const write = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  };
  async function result(action: () => Promise<unknown>) {
    try {
      const data = await action();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data as Record<string, unknown>,
      };
    } catch (error) {
      const code = error instanceof ControlError ? error.code : "unavailable";
      const data = {
        error: {
          code,
          ...(error instanceof ControlError && error.status !== undefined
            ? { http_status: error.status }
            : {}),
        },
      };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: data,
      };
    }
  }
  server.registerTool(
    "voxdock_list_targets",
    {
      description:
        "List authorized bound targets and current time for request expiry. No calls are started.",
      inputSchema: z.strictObject({}),
      annotations: read,
    },
    () => result(() => client.listTargets()),
  );
  server.registerTool(
    "voxdock_call",
    {
      description:
        "Request a real outbound phone call to an authorized bound target using an existing backend context reference. Acceptance does not mean connected. Preserve the same key and body after unknown outcomes; never automatically redial.",
      inputSchema: callInput,
      annotations: write,
    },
    (input) => result(() => client.createCall(input)),
  );
  server.registerTool(
    "voxdock_get_call",
    {
      description:
        "Read the status of a call owned by this credential; does not read call transcripts.",
      inputSchema: callIdInput,
      annotations: read,
    },
    (input) => result(() => client.getCall(input.call_id)),
  );
  server.registerTool(
    "voxdock_end_call",
    {
      description:
        "Request termination of a call owned by this credential. An uncertain outcome requires status inspection, not a new call.",
      inputSchema: callIdInput,
      annotations: write,
    },
    (input) => result(() => client.endCall(input.call_id)),
  );
  return server;
}
