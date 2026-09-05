/**
 * Camada de sincronização Firebase (opcional).
 * Com SYNC_ENABLED=false, todas as funções são no-ops / retornam local.
 *
 * Fotos: subcoleção Firestore embalagens/{id}/fotos/{photoId} (base64).
 * Firebase Storage NÃO é necessário (plano Spark / sem Blaze).
 */
import { SYNC_ENABLED, firebaseConfig, FIRESTORE_COLLECTION, STORAGE_PATH_PREFIX } from './firebase-config.js';

let app = null;
let db = null;
let ready = false;
let initError = null;

/** Limite aproximado do campo base64 (~900KB) — docs Firestore ≤ 1 MiB. */
export const PHOTO_BASE64_MAX = 900 * 1024;

function configLooksFilled() {
  const c = firebaseConfig;
  if (!c || !c.apiKey || c.apiKey === 'YOUR_API_KEY') return false;
  if (!c.projectId || c.projectId === 'YOUR_PROJECT_ID') return false;
  return true;
}

export function isSyncActive() {
  return SYNC_ENABLED && configLooksFilled() && ready;
}

export function getSyncStatus() {
  if (!SYNC_ENABLED) return { mode: 'local', message: 'Modo local (um aparelho)' };
  if (!configLooksFilled()) {
    return { mode: 'local', message: 'Sync ligado, mas firebase-config.js ainda tem placeholders' };
  }
  if (initError) return { mode: 'error', message: String(initError.message || initError) };
  if (!ready) return { mode: 'loading', message: 'Conectando Firebase…' };
  return { mode: 'sync', message: 'Sincronização ativa (Firestore · fotos na nuvem)' };
}

export async function initSync() {
  if (!SYNC_ENABLED || !configLooksFilled()) {
    ready = false;
    return false;
  }
  try {
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const { getFirestore } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    ready = true;
    initError = null;
    return true;
  } catch (err) {
    ready = false;
    initError = err;
    console.warn('Firebase init falhou:', err);
    return false;
  }
}

/** Upsert metadados do registro no Firestore (sem blobs). */
export async function syncUpsertRecord(record) {
  if (!isSyncActive() || !record) return;
  const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  const payload = { ...record };
  delete payload._localOnly;
  await setDoc(doc(db, FIRESTORE_COLLECTION, record.id), payload, { merge: true });
}

export async function syncDeleteRecord(id) {
  if (!isSyncActive() || !id) return;
  const { doc, deleteDoc, collection, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'
  );
  try {
    const fotosSnap = await getDocs(collection(db, FIRESTORE_COLLECTION, id, 'fotos'));
    await Promise.all(fotosSnap.docs.map((d) => deleteDoc(d.ref)));
  } catch (err) {
    console.warn('Falha ao apagar fotos remotas do registro:', err);
  }
  await deleteDoc(doc(db, FIRESTORE_COLLECTION, id));
}

export async function syncPullAll() {
  if (!isSyncActive()) return null;
  const { collection, getDocs } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  const snap = await getDocs(collection(db, FIRESTORE_COLLECTION));
  const list = [];
  snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
  return list;
}

/**
 * Escuta em tempo real a coleção embalagens.
 * onChange(recordsArray) a cada snapshot; retorna unsubscribe (no-op se sync inativo).
 */
export function subscribeRecords(onChange) {
  if (!isSyncActive()) {
    return () => {};
  }
  let unsub = () => {};
  let cancelled = false;
  (async () => {
    try {
      const { collection, onSnapshot } = await import(
        'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'
      );
      if (cancelled) return;
      unsub = onSnapshot(
        collection(db, FIRESTORE_COLLECTION),
        (snap) => {
          const list = [];
          snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
          onChange(list);
        },
        (err) => {
          console.warn('subscribeRecords:', err);
        }
      );
    } catch (err) {
      console.warn('subscribeRecords init:', err);
    }
  })();
  return () => {
    cancelled = true;
    unsub();
  };
}

/** Redimensiona (max edge) e comprime JPEG no browser via canvas. */
export async function compressImageBlob(blob, { maxEdge = 1280, quality = 0.7 } = {}) {
  if (!blob) return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    console.warn('compressImageBlob: createImageBitmap falhou', err);
    return blob;
  }
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return blob;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
  });
  return out || blob;
}

function blobToRawBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function rawBase64ToBlob(b64, mime = 'image/jpeg') {
  const bin = atob(String(b64 || ''));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime || 'image/jpeg' });
}

/**
 * Grava foto na subcoleção Firestore (não usa Storage).
 * @returns {{ ok: true } | { ok: false, reason: 'too_large' } | null}
 */
export async function syncUploadPhoto(recordId, photoId, blob, meta = {}) {
  if (!isSyncActive() || !recordId || !photoId || !blob) return null;
  const dataBase64 = await blobToRawBase64(blob);
  if (dataBase64.length > PHOTO_BASE64_MAX) {
    return { ok: false, reason: 'too_large' };
  }
  const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  const payload = {
    id: photoId,
    kind: meta.kind || 'box',
    createdAt: meta.createdAt || new Date().toISOString(),
    mime: 'image/jpeg',
    dataBase64,
  };
  await setDoc(doc(db, FIRESTORE_COLLECTION, recordId, 'fotos', photoId), payload, { merge: true });
  return { ok: true };
}

export async function syncDeletePhoto(recordId, photoId) {
  if (!isSyncActive() || !recordId || !photoId) return;
  try {
    const { doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
    await deleteDoc(doc(db, FIRESTORE_COLLECTION, recordId, 'fotos', photoId));
  } catch (err) {
    console.warn('Falha ao apagar foto no Firestore:', err);
  }
}

/**
 * Lê embalagens/{recordId}/fotos e devolve { id, kind, createdAt, mime, blob }[].
 */
export async function syncPullPhotos(recordId) {
  if (!isSyncActive() || !recordId) return [];
  try {
    const { collection, getDocs } = await import(
      'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'
    );
    const snap = await getDocs(collection(db, FIRESTORE_COLLECTION, recordId, 'fotos'));
    const list = [];
    snap.forEach((d) => {
      const data = d.data() || {};
      const mime = data.mime || 'image/jpeg';
      const b64 = data.dataBase64;
      if (!b64) return;
      list.push({
        id: data.id || d.id,
        kind: data.kind || 'box',
        createdAt: data.createdAt || '',
        mime,
        blob: rawBase64ToBlob(b64, mime),
      });
    });
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return list;
  } catch (err) {
    console.warn('syncPullPhotos:', err);
    return [];
  }
}

/**
 * Compat: devolve data URLs das fotos remotas (Firestore). Storage não é usado.
 * Preferir syncPullPhotos + IndexedDB.
 */
export async function syncListPhotoUrls(recordId) {
  const photos = await syncPullPhotos(recordId);
  return photos.map((p) => {
    const url = URL.createObjectURL(p.blob);
    return url;
  });
}

/* ---- Storage leftovers (unused / no-op) — plano Spark sem Blaze ---- */
export async function syncUploadPhotoStorage(/* recordId, photoId, blob */) {
  void STORAGE_PATH_PREFIX;
  return null;
}

export async function syncDeletePhotoStorage(/* recordId, photoId */) {
  return;
}
