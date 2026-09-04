/**
 * Call any MCP tool from the shell:
 *   node scripts/call.mjs <toolName> '<jsonArgs>'
 *
 * Example:
 *   node scripts/call.mjs ppro_split '{"track":"V0","index":0,"atSeconds":60}'
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [name, argsJson] = process.argv.slice(2);
if (!name) {
  console.error("usage: node scripts/call.mjs <toolName> '<jsonArgs>'");
  process.exit(2);
}

const client = new Client({ name: "call", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["mcp/server.js"] }));

const res = await client.callTool({
  name,
  arguments: argsJson ? JSON.parse(argsJson) : {},
});

console.log(res.content[0].text);
await client.close();
process.exit(res.isError ? 1 : 0);
