#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { debugEnabled } from "./simctl.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("iOS Simulator MCP server ready");
  if (debugEnabled()) {
    console.error("[simulator-mcp] debug logging enabled (SIMULATOR_MCP_DEBUG)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
