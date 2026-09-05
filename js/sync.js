/**
 * Camada de sincronização Firebase (opcional).
 * Com SYNC_ENABLED=false, todas as funções são no-ops / retornam local.
 */
import { SYNC_ENABLED, firebaseConfig, FIRESTORE_COLLECTION, STORAGE_PATH_PREFIX } from './firebase-config.js';

let app = null;
let db = null;
let storage = null;
let ready = false;
let initError = null;

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
  return { mode: 'sync', message: 'Sincronização ativa (Firestore + Storage)' };
}

export async function initSync() {
  if (!SYNC_ENABLED || !configLooksFilled()) {
    ready = false;
    return false;
  }
  try {
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const { getFirestore } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
    const { getStorage } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js');
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    storage = getStorage(app);
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
  const { doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
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

/** Envia foto para Storage: embalagens/{recordId}/{photoId} */
export async function syncUploadPhoto(recordId, photoId, blob) {
  if (!isSyncActive() || !recordId || !photoId || !blob) return null;
  const { ref, uploadBytes, getDownloadURL } = await import(
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js'
  );
  const path = `${STORAGE_PATH_PREFIX}/${recordId}/${photoId}`;
  const r = ref(storage, path);
  await uploadBytes(r, blob, { contentType: blob.type || 'image/jpeg' });
  return getDownloadURL(r);
}

export async function syncDeletePhoto(recordId, photoId) {
  if (!isSyncActive() || !recordId || !photoId) return;
  try {
    const { ref, deleteObject } = await import(
      'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js'
    );
    const path = `${STORAGE_PATH_PREFIX}/${recordId}/${photoId}`;
    await deleteObject(ref(storage, path));
  } catch (err) {
    console.warn('Falha ao apagar foto no Storage:', err);
  }
}

export async function syncListPhotoUrls(recordId) {
  if (!isSyncActive() || !recordId) return [];
  try {
    const { ref, listAll, getDownloadURL } = await import(
      'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js'
    );
    const folder = ref(storage, `${STORAGE_PATH_PREFIX}/${recordId}`);
    const res = await listAll(folder);
    const urls = await Promise.all(res.items.map((item) => getDownloadURL(item)));
    return urls;
  } catch {
    return [];
  }
}
