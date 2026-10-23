import type { DocumentState, View, Asset } from './types';
export interface Saved { version: 1; document: DocumentState; view: View }
export class Storage {
  private db: Promise<IDBDatabase>;
  constructor(private name = 'image-editor-v1') {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('state'); request.result.createObjectStore('assets'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('浏览器存储被其他页面占用'));
    });
    void this.db.catch(() => {});
  }
  async load(): Promise<{ saved: Saved; blobs: Map<string, Blob> } | null> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['state', 'assets'], 'readonly'), request = tx.objectStore('state').get('current');
      let result: { saved: Saved; blobs: Map<string, Blob> } | null = null;
      request.onsuccess = () => {
        const saved = request.result as Saved | undefined;
        if (!saved) return;
        if (saved.version !== 1) { tx.abort(); return; }
        result = { saved, blobs: new Map() };
        for (const id of new Set(saved.document.layers.map(l => l.asset))) {
          const r = tx.objectStore('assets').get(id);
          r.onsuccess = () => { if (r.result) result!.blobs.set(id, r.result); };
        }
      };
      tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('保存的文档无法读取'));
    });
  }
  async save(document: DocumentState, view: View, assets: Map<string, Asset>): Promise<void> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['state', 'assets'], 'readwrite'), store = tx.objectStore('assets');
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('编辑状态保存失败'));
      try {
        tx.objectStore('state').put({ version: 1, document, view } satisfies Saved, 'current');
        const retained = new Set(document.layers.map(l => l.asset));
        // Transactions run serially; the document and its source blobs are always saved atomically.
        for (const id of retained) { const a = assets.get(id); if (!a) throw new Error('原图丢失，未覆盖之前的保存'); store.put(a.blob, id); }
        const cursor = store.openKeyCursor(); cursor.onsuccess = () => { const c = cursor.result; if (c) { if (!retained.has(String(c.key))) store.delete(c.key); c.continue(); } };
      } catch (error) { tx.abort(); reject(error); }
    });
  }
  async close(): Promise<void> { (await this.db).close(); }
}
