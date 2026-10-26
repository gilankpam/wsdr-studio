// SPDX-License-Identifier: GPL-2.0-only
// A finished recording (<base>.sigmf-data + .sigmf-meta) from the page's storage (OPFS, where the engine
// writes) into the user's folder: streamed, the source removed only once its copy is complete. A file
// that fails stays where it was, and the error names it.
const EXTS = ['.sigmf-data', '.sigmf-meta'];

export async function moveRecording(from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle, base: string): Promise<{ moved: string[]; error?: string }> {
  const moved: string[] = [];
  const errors: string[] = [];
  for (const ext of EXTS) {
    const name = base + ext;
    try {
      const file = await (await from.getFileHandle(name)).getFile();
      const w = await (await to.getFileHandle(name, { create: true })).createWritable();
      await file.stream().pipeTo(w); // closes w: the copy is complete
      await from.removeEntry(name);
      moved.push(name);
    } catch (e) {
      errors.push(`${name}: ${(e as Error)?.message ?? e}`);
    }
  }
  return errors.length ? { moved, error: errors.join('; ') } : { moved };
}

// Recordings still in the page's storage (base names, sorted): from a tab closed or crashed while
// recording, or a move that failed. The worker lists them at startup, before any new recording starts,
// and moves them into the folder once there is one.
export async function leftoverRecordings(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const bases = new Set<string>();
  for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) {
    const ext = EXTS.find((e) => name.endsWith(e));
    if (ext) bases.add(name.slice(0, -ext.length));
  }
  return [...bases].sort();
}
