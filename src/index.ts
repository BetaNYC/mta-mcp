#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, callTool } from "./tools.js";
import { VERSION } from "./mta.js";
import { startupNotice } from "./freshness.js";

const server = new Server(
  { name: "mta-mcp", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callTool(request.params.name, request.params.arguments)
);

// Snapshot dates go to stderr. stdout is the MCP stdio channel, so nothing
// else may write there. Reading the dates touches only the files in data/.
const startedAt = new Date().toISOString();
for (const line of startupNotice(Date.now())) {
  process.stderr.write(`mta-mcp ${startedAt} snapshot_check: ${line}\n`);
}

// Nothing is fetched here. The server makes an upstream request only in direct
// response to a tool call — no warm-up, no prefetch, no background poll.
const transport = new StdioServerTransport();
await server.connect(transport);
