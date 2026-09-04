/**
 * Walks argument shapes against an undocumented binding until the error stops
 * being "Not Enough Parameters", which brackets the real arity and types.
 * Only calls create*Action, which build an Action without mutating anything.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const c = new Client({ name: "sig", version: "0.1.0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["mcp/server.js"] }));

const PROJECT_ITEM = { $projectItemId: "d8f034d7-04bc-4742-95ad-4a7686700e49" };
const CLIP = { $trackItem: { track: "V0", index: 0 } };
const T0 = { $ticks: "0" };
const T5 = { $seconds: 5 };
const SEL = { $selection: [{ track: "V0", index: 0 }] };
const VIDEO = { $const: "MediaType.VIDEO" };

const SEL2 = { $selection: [{ track: "V0", index: 0 }] };
const AUDIO = { $const: "MediaType.AUDIO" };
const ANY = { $const: "MediaType.ANY" };

const shapes = {
  "projectItem": [PROJECT_ITEM],
  "projectItem,time": [PROJECT_ITEM, T5],
  "projectItem,time,v": [PROJECT_ITEM, T5, 0],
  "projectItem,time,v,a": [PROJECT_ITEM, T5, 0, 0],
  "projectItem,time,v,a,bool": [PROJECT_ITEM, T5, 0, 0, true],
  "trackItem": [CLIP],
  "trackItem,time": [CLIP, T5],
  "trackItem,time,v": [CLIP, T5, 0],
  "trackItem,time,v,a": [CLIP, T5, 0, 0],
  "trackItem,time,in,out": [CLIP, T5, T0, T5],
  "selection": [SEL],
  "selection,time": [SEL, T5],
  "selection,bool": [SEL, true],
  "selection,bool,mediaType": [SEL, true, VIDEO],
  "selection,bool,mediaType,bool": [SEL, true, VIDEO, false],
  "selection,time,v,a": [SEL, T5, 0, 0],
  "selection,time,mediaType,bool": [SEL, T5, ANY, false],
  "liveSelection": [{ $liveSelection: true }],
  "trackItem,time,in,out,v,a": [CLIP, T5, T0, T5, 0, 0],
  "trackItem,in,out": [CLIP, T0, T5],
  "projectItem,in,out,time": [PROJECT_ITEM, T0, T5, T5],
  "projectItem,in,out,time,v,a": [PROJECT_ITEM, T0, T5, T5, 0, 0],
};

for (const method of ["createAddItemAction", "createAddItemsAction"]) {
  console.log(`\n${"=".repeat(72)}\n${method}\n${"=".repeat(72)}`);
  for (const [label, args] of Object.entries(shapes)) {
    const r = await c.callTool({
      name: "ppro_debug_invoke",
      arguments: { target: "sequenceEditor", method, args },
    });
    let d;
    try { d = JSON.parse(r.content[0].text); } catch { d = { error: r.content[0].text }; }
    const verdict = d.ok ? `OK -> ${d.resultType} ${JSON.stringify(d.resultMethods || "")}` : d.error;
    console.log(`  ${label.padEnd(26)} ${verdict}`);
  }
}
await c.close();
process.exit(0);
