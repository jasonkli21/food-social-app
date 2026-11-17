import type { Attachment } from '../types';

const urls = new Map<string, string>();
let connection: Promise<IDBDatabase> | undefined;

function database() {
  connection ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('goodfork-demo', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('media');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return connection;
}

async function change(key: string, value?: Blob) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('media', 'readwrite');
    const store = transaction.objectStore('media');
    if (value) store.put(value, key);
    else store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function keepAttachment(attachment: Attachment, id: string) {
  const key = 'local:' + id;
  const blob = attachment.file ?? await (await fetch(attachment.uri)).blob();
  await change(key, blob);
  return key;
}

export async function dropAttachment(source: string) {
  if (!source.startsWith('local:')) return;
  const current = urls.get(source);
  if (current) URL.revokeObjectURL(current);
  urls.delete(source);
  await change(source);
}

export async function resolveAttachment(source: string) {
  if (!source.startsWith('local:')) return source;
  const cached = urls.get(source);
  if (cached) return cached;
  const db = await database();
  const blob = await new Promise<Blob | undefined>((resolve, reject) => {
    const req = db.transaction('media').objectStore('media').get(source);
    req.onsuccess = () => resolve(req.result as Blob | undefined);
    req.onerror = () => reject(req.error);
  });
  if (!blob) return '';
  const interactive = urls.get(source) ?? URL.createObjectURL(blob);
  urls.set(source, interactive);
  return interactive;
}
