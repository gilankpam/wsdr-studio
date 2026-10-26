// SPDX-License-Identifier: GPL-2.0-only
// The web build's recording folder: one the user picked (File System Access API), remembered in
// IndexedDB. The engine records into the page's own storage (OPFS); the worker moves each finished file
// here (core/move.ts).
type Permissioned = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
};

export type FolderStore = {
  get(): Promise<FileSystemDirectoryHandle | undefined>;
  set(h: FileSystemDirectoryHandle): Promise<void>;
};

// The folder to record into, or null when the user closed the picker. Must run in a user gesture
// (Rec / Ctrl+R): both the permission prompt and the picker need one.
export async function ensureFolder(store: FolderStore, pick: () => Promise<FileSystemDirectoryHandle>): Promise<FileSystemDirectoryHandle | null> {
  const h = (await store.get()) as Permissioned | undefined;
  if (h) {
    let p = await h.queryPermission({ mode: 'readwrite' });
    if (p === 'prompt') p = await h.requestPermission({ mode: 'readwrite' });
    if (p === 'granted') return h;
  }
  try {
    const n = await pick();
    await store.set(n);
    return n;
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return null;
    throw e;
  }
}

export const pickFolder = () =>
  (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({
    id: 'wsdr-recordings', mode: 'readwrite', startIn: 'documents',
  });

// IndexedDB "wsdr", store "folders", key "recordings".
export function idbFolderStore(): FolderStore {
  const db = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('wsdr', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('folders');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const run = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const q = f(d.transaction('folders', mode).objectStore('folders'));
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    }).finally(() => d.close());
  };
  return {
    get: () => run('readonly', (s) => s.get('recordings')),
    set: async (h) => void (await run('readwrite', (s) => s.put(h, 'recordings'))),
  };
}
