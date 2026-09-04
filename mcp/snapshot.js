/**
 * §5 / §9.4 — rollback by copying the .prproj, not by the undo API.
 *
 * The unit of rollback is one user turn, so a snapshot is a plain file copy
 * taken before the agent touches anything. This is independent of whatever
 * Premiere considers an atomic operation, and independent of executeTransaction.
 *
 * Caveat worth knowing: this captures the project as last SAVED. Unsaved edits
 * sitting in Premiere's memory are not in the file, so a restore returns you to
 * the last save point, not to the exact on-screen state.
 */
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const SNAPSHOT_DIR = process.env.PPRO_SNAPSHOT_DIR || "snapshots";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

export async function createSnapshot(projectPath, label = "turn") {
  const st = await stat(projectPath); // throws a clear ENOENT if the path is wrong
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const name = `${stamp()}__${label}__${basename(projectPath)}`;
  const dest = join(SNAPSHOT_DIR, name);
  await copyFile(projectPath, dest);
  return { snapshot: dest, bytes: st.size, sourceModified: st.mtime.toISOString() };
}

export async function listSnapshots() {
  try {
    const names = (await readdir(SNAPSHOT_DIR)).filter((n) => n.endsWith(".prproj")).sort().reverse();
    return Promise.all(
      names.map(async (n) => {
        const p = join(SNAPSHOT_DIR, n);
        const st = await stat(p);
        return { snapshot: p, bytes: st.size, created: st.mtime.toISOString() };
      })
    );
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

/**
 * Restores over the original path. Premiere must have the project CLOSED, or it
 * will overwrite the file again from memory on its next save.
 */
export async function restoreSnapshot(snapshotPath, projectPath) {
  await stat(snapshotPath);
  const backup = join(dirname(snapshotPath), `${stamp()}__pre-restore__${basename(projectPath)}`);
  try {
    await copyFile(projectPath, backup); // never destroy the current state to restore
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await copyFile(snapshotPath, projectPath);
  return { restored: projectPath, from: snapshotPath, previousStateSavedTo: backup };
}
