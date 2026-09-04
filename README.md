# Premiere MCP

Premiere Pro as the execution layer of an editing agent.
Replaces an ffmpeg executor with mutation of the open Premiere project.

**Status:** working prototype that has been through a production run — a
30-second draft assembled from a transcript on real material, both step by step
(~30 min) and in a single `ppro_apply_cutlist` call (25 s). Working: timeline
reads, snapshots, splitting, ripple delete, text-based addressing, transcript
cleanup, segment reordering, B-roll on upper tracks, frame verification.

**Not verified:** ripple cleanup of dialogue underneath existing B-roll (does V1
drift against V0), `shiftOverlapping` in `createRemoveItemsAction`, audio
verification of the result.

| Document | What's inside |
|---|---|
| [docs/api-traps.md](docs/api-traps.md) | **API traps — read before editing the panel** |
| [CLAUDE.md](CLAUDE.md) | invariants for an agent working in this repository |

---

## Architecture

```
MCP client (Claude Code)
      | stdio
mcp/server.js            - MCP server: tools, planning, time mapping
      | ws://127.0.0.1:3001
proxy/server.js          - broker for commands and responses
      | ws (the panel is the client: there is no Node inside UXP)
panel/main.js            - UXP panel inside Premiere
      |
premierepro API
```

**Why the layers split this way.** The panel holds only primitives over the
API, no logic. Planning, time mapping and orchestration live on the MCP side,
where they can change without reloading the plugin and be tested without
Premiere.

---

## Setting up on a new machine

### 1. Requirements

- **Premiere Pro >= 26.3** (the manifest requires `26.3.0`; UXP is stable from 25.6)
- **Node.js >= 20** — `brew install node`
- **UXP Developer Tool** — Creative Cloud Desktop -> Marketplace
- **ffmpeg/ffprobe** (for the analysis layer) — `brew install ffmpeg`

> The UDT CLI (`@adobe/uxp-devtools-cli`) **does not work on Apple Silicon**:
> the native part, `@adobe/uxp-devtools-helper`, is built for x86_64 only (its
> single release, from 2021). Load the plugin through the GUI instead.

The `premierepro-*.d.ts` TypeScript declarations are not part of this
repository — they are Adobe's proprietary files and cannot be redistributed
here. They are not needed to run anything; if you want API autocompletion, take
them from the UXP Developer Tool (the Premiere plugin template) or from the
Adobe UXP for Premiere Pro documentation and drop them into `docs/` —
`.gitignore` already covers them.

### 2. Dependencies

```bash
npm install
```

### 3. Proxy

Start it **before** loading the panel (otherwise the panel spins in a reconnect
loop — harmless, it picks the proxy up on its own).

```bash
npm run proxy
```

### 4. The panel inside Premiere

1. Premiere -> Settings -> Plugins -> **Enable Developer Mode**
2. **Restart Premiere.** Without this Premiere never connects to the UDT
   service and loading fails with "No applications are connected to the service".
3. UDT -> **Add Plugin** -> `panel/manifest.json`
4. Actions -> **Load & Watch** (Watch reloads the panel on edits by itself)
5. Premiere -> Window -> Extensions -> *Premiere MCP Agent*
6. The panel should light up green: `connected`

### When the panel needs a reload

| What you changed | What to do |
|---|---|
| `panel/*.js`, `*.html`, `*.css` | Watch reloads it; otherwise Reload in UDT |
| `panel/manifest.json` | **Unload -> Load** (Watch does not cover the manifest) |
| `mcp/`, `proxy/`, `scripts/` | depends on how you call it — see below |

> **A registered MCP server is a persistent process.** It starts once, when the
> client session starts, and keeps running: editing `mcp/server.js` does NOT
> affect the tools your client already has. Restart the client session, or call
> through `node scripts/call.mjs`, which spawns a fresh server per call. Three
> debugging runs were once spent on code that was never executing.

> Watch misfires sometimes. If a new command answers `unknown command: ...`,
> hit Reload by hand.

### 5. Connecting to Claude Code

```bash
claude mcp add premiere -- node "$(pwd)/mcp/server.js"
```

The default scope is local (this project, this user). `-s user` gives you the
server in every project; `-s project` writes it into `.mcp.json` next to the
code. Check with `claude mcp list` -> `premiere: ✓ Connected`. The panel is not
required for registration: without it the server still starts and lists its
tools, only the calls fail.

---

## Checking the install

```bash
node scripts/call.mjs ppro_echo '{"message":"hi"}'
```

Expect `version: "26.3.2"`. Then:

```bash
node scripts/call.mjs ppro_env '{}'
node scripts/call.mjs ppro_timeline_dump '{}'
```

Without Premiere only the plumbing can be tested:

```bash
npm run fake-panel   # in a separate terminal
npm run smoke
```

### Linting

```bash
npm run lint
```

Adobe's own rules (`@adobe/eslint-plugin-premierepro`) for the premierepro API:
actions built outside `lockedAccess`, actions escaping their lock scope, async
callbacks where the API demands synchronous ones. These are the failures
api-traps §1 and §3 describe, caught statically. One entry in that file (§10)
turned out to be a lint error rather than the API trap it was recorded as.

---

## MCP tools

### Reading

| Tool | Purpose |
|---|---|
| `ppro_echo` | round trip to the panel |
| `ppro_env` | version, project, sequence, feature detection |
| `ppro_timeline_dump` | tracks, clips, timings, synthesized keys |
| `ppro_selection` | selection + playhead |
| `ppro_sequence_list` | sequences with frame size |
| `ppro_transcript_probe` | a clip's transcript (JSON) |
| `ppro_find_phrase` | phrase -> timing + cut point |
| `ppro_cleanup_plan` | cleanup plan, changes nothing |

### Assembly — composite, they snapshot for you

| Tool | Purpose |
|---|---|
| `ppro_apply_cutlist` | keep spans in the desired final order -> finished sequence **in one call**: duplicate, rename, cuts right to left, orphan-clone sweep, close gaps, reorder, verification against the plan |
| `ppro_cleanup_apply` | full transcript cleanup in a duplicate of the sequence |
| `ppro_reorder` | rearranges segments by **cloning** through a parking zone past the timeline end (moving clips past neighbours corrupts the project irreversibly — api-traps §5a) |

### Primitives — the caller owns the snapshot

| Tool | Purpose |
|---|---|
| `ppro_sequence_duplicate` | copy of a sequence with all its settings |
| `ppro_sequence_rename` | rename a sequence (via `ProjectItem.createSetNameAction`) |
| `ppro_sequence_delete` | delete a sequence |
| `ppro_split_at` | split (clone into free space + trim + move) |
| `ppro_remove_at` | remove the clips at a time, optionally with ripple; `onlyTrack` limits it to one track, leaving the dialogue underneath alone |
| `ppro_clone_at` | clone clips into free space; `onlyTrack` + `videoTrackOffset` gives a video-only clone on V1, for B-roll |
| `ppro_move_at` | shift clips by an offset — **only where their relative order is preserved** (§5a) |
| `ppro_retrim` | one clip's boundaries: timeline start/end and source in/out |
| `ppro_trim` | trim the tail (with the linked audio) |
| `ppro_trim_head` | drop the head and close the gap |
| `ppro_close_gaps` | close the gaps left by ripple |
| `ppro_remove_items` | delete project items by name prefix (`agent_`) |
| `ppro_project_save` | save the project so a snapshot captures the on-screen state |
| `ppro_grab_frame` | a frame from the Program Monitor as PNG |

### Rollback

| Tool | Purpose |
|---|---|
| `ppro_snapshot_create` | save the project and copy the `.prproj` |
| `ppro_snapshot_list` | list the snapshots |
| `ppro_snapshot_restore` | restore one (the project must be **closed** in Premiere) |

### Debugging

| Tool | Purpose |
|---|---|
| `ppro_debug_invoke` | reflective API method call without committing |
| `ppro_debug_arity` | arity of the `SequenceEditor` methods |
| `ppro_capabilities` | what this host actually has at runtime — declarations are not evidence |

### Markers, tracks, detection

| Tool | Purpose |
|---|---|
| `ppro_markers_list` | markers on the active sequence |
| `ppro_marker_add` | add a marker, verified by re-reading |
| `ppro_markers_remove` | remove markers by guid, or all of them |
| `ppro_track_mute` | mute/unmute a track |
| `ppro_scene_detect` | Premiere's own scene-edit detection: cuts, markers or subclips. Video only, not aimable, not idempotent, not undoable — read api-traps §6 first |

---

## Typical scenarios

### Transcript cleanup

```bash
# 1. what is said on camera, and where
node scripts/call.mjs ppro_find_phrase '{"phrase":"so what we did next"}'

# 2. look at the plan without touching anything
node scripts/call.mjs ppro_cleanup_plan '{}'

# 3. dry run — where the cuts would land
node scripts/call.mjs ppro_cleanup_apply '{"dryRun":true}'

# 4. apply, in a duplicate of the sequence
node scripts/call.mjs ppro_cleanup_apply '{}'
```

### Assembling a draft from soundbites

Spans are in seconds of the sequence as it stands at call time, listed **in the
desired final order** (the tool does the reordering itself).

```bash
node scripts/call.mjs ppro_apply_cutlist '{"dryRun":true,"name":"draft-v1","keeps":[
  {"start":41.2,"end":47.9,"label":"hook"},
  {"start":3.4,"end":9.8,"label":"intro"},
  {"start":62.0,"end":71.5,"label":"payoff"}
]}'
```

Drop `dryRun` and about 25 s later the assembled sequence is in the project. The
snapshot before editing is taken automatically.

---

## Environment variables

| Variable | Default |
|---|---|
| `PPRO_PROXY_PORT` | `3001` |
| `PPRO_PROXY_HOST` | `127.0.0.1` |
| `PPRO_PROXY_URL` | `ws://127.0.0.1:3001` |
| `PPRO_COMMAND_TIMEOUT_MS` | `60000` |
| `PPRO_SNAPSHOT_DIR` | `snapshots` |

---

## Before editing the panel

Read [docs/api-traps.md](docs/api-traps.md). Fifteen entries, each one paid for
with a separate debugging session: stale handles, non-atomic transactions,
unlinked audio, the missing razor, gaps after ripple.

The two most expensive — read them before touching any editing logic:

- **§5a** — `createMoveAction` past neighbours commits cleanly and **corrupts
  the project irreversibly** (UI, renderer and API model diverge; the damage
  survives saving and reopening). Reorder segments only by cloning.
- **§5b** — `createSetInPointAction` / `createSetOutPointAction` on a track item
  behave non-deterministically and poison the getters. Set the source window
  only through `createSetStartAction` / `createSetEndAction`.

---

## Author and licence

**Max Sebastian** — MIT, see [LICENSE](LICENSE).

Premiere Pro, Adobe and UXP are trademarks of Adobe Inc. This project is not
affiliated with Adobe and does not redistribute its files.
