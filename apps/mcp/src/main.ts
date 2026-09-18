import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { clientFromEnvironment } from "@voxdock/control-client";
import { createMcpServer } from "./server.js";

try {
  const server = createMcpServer(await clientFromEnvironment());
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write(
    "VoxDock MCP could not start. Check its URL, credential file, and runtime configuration.\n",
  );
  process.exitCode = 1;
}
