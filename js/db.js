/**
 * IndexedDB para fotos por recordId (caixa embalada).
 */

const DB_NAME = 'cgi_pack_photos_v1';
const DB_VERSION = 1;
const STORE = 'photos';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('recordId', 'recordId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('abort'));
  });
}

export async function addPhoto(recordId, blob, meta = {}) {
  const db = await openDB();
  const id = crypto.randomUUID();
  const record = {
    id,
    recordId: String(recordId),
    blob,
    mime: blob.type || 'image/jpeg',
    createdAt: new Date().toISOString(),
    ...meta,
  };
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(record);
  await txDone(tx);
  db.close();
  return id;
}

export async function listPhotosForRecord(recordId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('recordId');
    const req = idx.getAll(String(recordId));
    req.onsuccess = () => {
      const rows = (req.result || []).sort((a, b) =>
        String(a.createdAt).localeCompare(String(b.createdAt))
      );
      db.close();
      resolve(rows);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deletePhoto(photoId) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(photoId);
  await txDone(tx);
  db.close();
}

export async function deleteAllPhotosForRecord(recordId) {
  const photos = await listPhotosForRecord(recordId);
  if (!photos.length) return;
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const p of photos) store.delete(p.id);
  await txDone(tx);
  db.close();
}

export function photoObjectURL(photo) {
  if (!photo || !photo.blob) return null;
  return URL.createObjectURL(photo.blob);
}

/** Converte blob para data URL (backup best-effort). */
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function dataURLToBlob(dataURL) {
  const parts = String(dataURL).split(',');
  const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(parts[1] || '');
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
