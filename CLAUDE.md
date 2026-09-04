# Invariants for the agent

This repository is a layer between an MCP client and Premiere Pro. The agent
working here does not "write code to spec" — it mutates someone's project
inside someone's application, where part of the API is undocumented and part
of it is actively dangerous.

**Read [docs/api-traps.md](docs/api-traps.md) before touching any editing
logic.** Fifteen entries, each one paid for with a separate debugging session.

## Three rules whose violation costs the user their project

1. **Never reorder clips past their neighbours with `createMoveAction`.** A
   move that changes the chronological order of clips on a track commits
   cleanly — and corrupts the project irreversibly: the UI, the renderer and
   the API model diverge, and the damage survives saving and reopening. Change
   order only by cloning (§5a).
2. **Never use `createSetInPointAction` / `createSetOutPointAction` on a track
   item.** The behaviour is non-deterministic and the getters lie afterwards.
   Set the source window only through `createSetStartAction` /
   `createSetEndAction` (§5b).
3. **A command's reply is not proof.** Verify every edit by re-reading the
   timeline, and anything doubtful with a frame from `ppro_grab_frame` (§13).

## Before mutating

The composite tools (`ppro_apply_cutlist`, `ppro_cleanup_apply`,
`ppro_reorder`) snapshot the `.prproj` themselves. The primitives do not:
start a chain of primitives with `ppro_snapshot_create`. The snapshot is the
only way back from the §5a corruption — undo does not save you there.

Mutate a **duplicate** of the sequence, never the user's original.

## Layer split

```
mcp/server.js     tools, planning, time mapping        <- logic lives here
proxy/server.js   command broker
panel/main.js     primitives over the premierepro API  <- no logic
```

The reason is not stylistic: `panel/` needs a plugin Reload inside Premiere,
while `mcp/` can be reloaded far more cheaply. Anything that can be solved on
the MCP side is solved on the MCP side.

**But a registered MCP server is a persistent process**, started once with the
client session. Editing `mcp/server.js` does not change the tools the client
already holds — restart the session, or call through `node scripts/call.mjs`,
which spawns a fresh server per call. Three debugging runs were once spent on
code that was never executing.

Editing `panel/*.js` -> Reload in UDT. Editing `panel/manifest.json` -> Unload
then Load. If a new command answers `unknown command:`, the panel did not
reload.

## API working pattern

Track item handles go stale across `await`. Build actions **inside**
`lockedAccess`, re-acquiring the items there; address clips by a
`{track, index}` pair rather than by a stored object. See `timeline.trimHead`
and `timeline.removeAt` in [panel/main.js](panel/main.js) for the shape.

## Checking without Premiere

```bash
npm run fake-panel   # in a separate terminal
npm run smoke
```

This exercises the MCP -> proxy -> panel plumbing. It does not cover the real
editing logic: the fake panel serves canned answers.

```bash
npm run lint
```

Adobe's own lint rules for this API. Run them before treating a lock-related
failure as a mystery: two entries in api-traps turned out to be lint errors.
