/**
 * Dry-run the cleanup planner against a saved transcript, with no Premiere in
 * the loop. Prints the plan so every cut can be checked line by line before
 * anything touches a project.
 *
 *   node scripts/plan-cleanup.mjs [transcript.json] [maxPauseSeconds]
 */
import { readFile } from "node:fs/promises";
import { planCleanup } from "../mcp/cleanup.js";

const file = process.argv[2] || "out/transcript-full.json";
const maxPause = Number(process.argv[3] || 1.0);

const transcript = JSON.parse(await readFile(file, "utf8"));
const duration = Math.max(
  ...transcript.segments.map((s) => s.start + s.duration)
);

const { cuts, keeps, heldForReview, stats } = planCleanup(transcript, duration, {
  maxPauseSeconds: maxPause,
});

console.log("stats:", JSON.stringify(stats, null, 2));

console.log(`\ncuts (${cuts.length}):`);
for (const c of cuts) {
  const len = (c.end - c.start).toFixed(2);
  const why = c.reason === "disfluency"
    ? `disfluency ${JSON.stringify(c.text)}`
    : `pause ${c.gap}s  ${JSON.stringify(c.after)} -> ${JSON.stringify(c.before)}`;
  console.log(`  ${c.start.toFixed(2).padStart(7)}s +${len.padStart(5)}s  ${why}`);
}

if (heldForReview.length) {
  console.log(`\nHELD FOR REVIEW (${heldForReview.length}) — too long to remove on audio alone:`);
  for (const c of heldForReview) {
    console.log(`  ${c.start.toFixed(2).padStart(7)}s +${(c.end - c.start).toFixed(2)}s  ${c.reason} ${JSON.stringify(c.after || c.text)} -> ${JSON.stringify(c.before || "")}`);
  }
}

console.log(`\nkeep ranges (${keeps.length}):`);
for (const k of keeps) {
  console.log(`  ${k.start.toFixed(2).padStart(7)}s -> ${k.end.toFixed(2).padStart(7)}s  (${(k.end - k.start).toFixed(2)}s)`);
}
