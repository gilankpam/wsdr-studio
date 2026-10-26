// SPDX-License-Identifier: GPL-2.0-only
// In-memory stand-ins for the File System Access handles (directory, file), for the recording tests.
export class FakeFileHandle {
  readonly kind = 'file';
  name: string;
  dir: FakeDir;
  constructor(dir: FakeDir, name: string) { this.dir = dir; this.name = name; }
  async getFile() { return new Blob([this.dir.files.get(this.name) ?? new Uint8Array()]); }
  async createWritable() {
    if (this.dir.failWrite.has(this.name)) throw new DOMException('disk full', 'QuotaExceededError');
    const chunks: Uint8Array[] = [];
    return new WritableStream<Uint8Array>({
      write: (c) => void chunks.push(c),
      close: () => void this.dir.files.set(this.name, new Uint8Array(Buffer.concat(chunks))),
    });
  }
}

export class FakeDir {
  readonly kind = 'directory';
  name: string;
  files = new Map<string, Uint8Array>();
  failWrite = new Set<string>();
  permission: 'granted' | 'prompt' | 'denied' = 'granted';
  afterRequest: 'granted' | 'denied' = 'granted';
  requested = 0;
  constructor(name: string) { this.name = name; }
  async getFileHandle(name: string, o: { create?: boolean } = {}) {
    if (!this.files.has(name)) {
      if (!o.create) throw new DOMException(name, 'NotFoundError');
    }
    return new FakeFileHandle(this, name);
  }
  async removeEntry(name: string) { this.files.delete(name); }
  async *entries(): AsyncGenerator<[string, FakeFileHandle]> {
    for (const n of [...this.files.keys()]) yield [n, new FakeFileHandle(this, n)];
  }
  async queryPermission() { return this.permission; }
  async requestPermission() { this.requested++; return (this.permission = this.afterRequest); }
}
