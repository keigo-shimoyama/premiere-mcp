/**
 * End-to-end smoke test: MCP client -> MCP server -> proxy -> panel -> back.
 * Run against scripts/fake-panel.js to test the plumbing without Premiere, or
 * against the real UXP panel to test the whole path.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke-test", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["mcp/server.js"] }));

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);

let failures = 0;
for (const name of ["ppro_echo", "ppro_env", "ppro_timeline_dump", "ppro_selection"]) {
  const args = name === "ppro_echo" ? { message: "hello premiere" } : {};
  const res = await client.callTool({ name, arguments: args });
  const body = res.content[0].text;
  if (res.isError) {
    failures++;
    console.log(`FAIL ${name}: ${body}`);
  } else {
    console.log(`ok   ${name}: ${body.replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

await client.close();
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
