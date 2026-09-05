/**
 * Camada de sincronização Firebase (opcional).
 * Com SYNC_ENABLED=false, todas as funções são no-ops / retornam local.
 *
 * Fotos (caminho principal): campo photosInline[] no documento embalagens/{id}
 *   (até 3 fotos base64 ≤ ~280 KiB cada). Subcoleção/chunks fica como tentativa opcional.
 * Firebase Storage NÃO é necessário (plano Spark / sem Blaze).
 */
import { SYNC_ENABLED, firebaseConfig, FIRESTORE_COLLECTION, STORAGE_PATH_PREFIX } from './firebase-config.js';
import { isTombstoned, addTombstone } from './storage.js';

/** Coleção Firestore de tombstones (doc id = recordId). */
export const FIRESTORE_EXCLUIDOS = 'excluidos';

let app = null;
let db = null;
let ready = false;
let initError = null;

/** Alvo por foto inline no documento (3 × 280 KiB ≈ 840 KiB + campos < 1 MiB). */
export const PHOTO_BASE64_MAX = 280 * 1024;

/** Máximo de fotos no campo photosInline do registro. */
export const PHOTO_INLINE_MAX = 3;

/** Tamanho aproximado de cada fatia de base64 nos chunks (secundário). */
export const PHOTO_CHUNK_CHARS = 400000;

const COMPRESS_STEPS = [
  { maxEdge: 1280, quality: 0.7 },
  { maxEdge: 960, quality: 0.6 },
  { maxEdge: 720, quality: 0.55 },
  { maxEdge: 560, quality: 0.5 },
  { maxEdge: 480, quality: 0.45 },
  { maxEdge: 400, quality: 0.4 },
];

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
  return { mode: 'sync', message: 'Sincronização ativa (Firestore · fotos na mesma lista)' };
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

/** Upsert metadados do registro no Firestore (sem blobs). Recusa se tombstoned. */
export async function syncUpsertRecord(record) {
  if (!isSyncActive() || !record) return;
  if (!record.id || isTombstoned(record.id)) {
    console.warn('syncUpsertRecord: recusado — id tombstoned', record?.id);
    return { ok: false, reason: 'tombstoned' };
  }
  const { doc, setDoc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  try {
    const ex = await getDoc(doc(db, FIRESTORE_EXCLUIDOS, record.id));
    if (ex.exists()) {
      addTombstone(record.id);
      console.warn('syncUpsertRecord: recusado — está em excluidos', record.id);
      return { ok: false, reason: 'tombstoned' };
    }
  } catch (err) {
    console.warn('syncUpsertRecord: check excluidos falhou', err);
  }
  const payload = { ...record };
  delete payload._localOnly;
  await setDoc(doc(db, FIRESTORE_COLLECTION, record.id), payload, { merge: true });
  return { ok: true };
}

async function deletePhotoDocDeep(recordId, photoId) {
  const { doc, deleteDoc, collection, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'
  );
  try {
    const chunksSnap = await getDocs(
      collection(db, FIRESTORE_COLLECTION, recordId, 'fotos', photoId, 'chunks')
    );
    await Promise.all(chunksSnap.docs.map((d) => deleteDoc(d.ref)));
  } catch (err) {
    console.warn('Falha ao apagar chunks da foto:', err);
  }
  await deleteDoc(doc(db, FIRESTORE_COLLECTION, recordId, 'fotos', photoId));
}

export async function syncDeleteRecord(id) {
  if (!isSyncActive() || !id) return;
  const { doc, deleteDoc, collection, getDocs } = await import(
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'
  );
  try {
    const fotosSnap = await getDocs(collection(db, FIRESTORE_COLLECTION, id, 'fotos'));
    for (const d of fotosSnap.docs) {
      try {
        await deletePhotoDocDeep(id, d.id);
      } catch (err) {
        console.warn('Falha ao apagar foto remota:', err);
        try {
          await deleteDoc(d.ref);
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('Falha ao apagar fotos remotas do registro:', err);
  }
  await deleteDoc(doc(db, FIRESTORE_COLLECTION, id));
}

/** Marca id como excluído na coleção excluidos/{id}. */
export async function syncMarkExcluded(id) {
  if (!isSyncActive() || !id) return;
  const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  await setDoc(
    doc(db, FIRESTORE_EXCLUIDOS, String(id)),
    { deletedAt: new Date().toISOString() },
    { merge: true }
  );
}

/** Lista ids tombstoned remotos (coleção excluidos). */
export async function syncPullExcludedIds() {
  if (!isSyncActive()) return [];
  const { collection, getDocs } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  const snap = await getDocs(collection(db, FIRESTORE_EXCLUIDOS));
  const ids = [];
  snap.forEach((d) => ids.push(d.id));
  return ids;
}

/**
 * Escuta em tempo real a coleção excluidos.
 * onChange(string[] ids) a cada snapshot; retorna unsubscribe.
 */
export function subscribeExcluded(onChange) {
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
        collection(db, FIRESTORE_EXCLUIDOS),
        (snap) => {
          const ids = [];
          snap.forEach((d) => ids.push(d.id));
          onChange(ids);
        },
        (err) => {
          console.warn('subscribeExcluded:', err);
        }
      );
    } catch (err) {
      console.warn('subscribeExcluded init:', err);
    }
  })();
  return () => {
    cancelled = true;
    unsub();
  };
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

export function rawBase64ToBlob(b64, mime = 'image/jpeg') {
  const bin = atob(String(b64 || ''));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime || 'image/jpeg' });
}

/**
 * Loop agressivo: 1280@0.7 → … → 400@0.4 até base64.length <= maxChars (default 280 KiB).
 * @returns {{ ok: true, blob: Blob, base64: string } | { ok: false, blob: Blob, base64: string, reason: 'too_large' }}
 */
export async function compressUntilFit(blob, maxChars = PHOTO_BASE64_MAX) {
  if (!blob) return { ok: false, blob: null, base64: '', reason: 'too_large' };
  const limit = Number(maxChars) > 0 ? Number(maxChars) : PHOTO_BASE64_MAX;
  let current = blob;
  let base64 = await blobToRawBase64(current);
  if (base64.length <= limit) {
    return { ok: true, blob: current, base64 };
  }
  for (const step of COMPRESS_STEPS) {
    try {
      const next = (await compressImageBlob(current, step)) || current;
      current = next;
      base64 = await blobToRawBase64(current);
      if (base64.length <= limit) {
        return { ok: true, blob: current, base64 };
      }
    } catch (err) {
      console.warn('compressUntilFit step falhou:', step, err);
    }
  }
  return { ok: false, blob: current, base64, reason: 'too_large' };
}

/**
 * Constrói photosInline a partir de blobs locais (máx PHOTO_INLINE_MAX).
 * Prefere pelo menos 1 capa: inclui as que couberem ≤ PHOTO_BASE64_MAX.
 * @param {{ id: string, blob: Blob, createdAt?: string, kind?: string, mime?: string }[]} photos
 * @returns {Promise<{ inline: object[], skipped: number, errors: string[] }>}
 */
export async function buildPhotosInline(photos) {
  const inline = [];
  let skipped = 0;
  const errors = [];
  const list = Array.isArray(photos) ? photos : [];
  for (const p of list) {
    if (inline.length >= PHOTO_INLINE_MAX) break;
    if (!p?.blob) {
      skipped += 1;
      continue;
    }
    try {
      const fitted = await compressUntilFit(p.blob, PHOTO_BASE64_MAX);
      if (!fitted.ok || !fitted.base64) {
        skipped += 1;
        continue;
      }
      inline.push({
        id: p.id || crypto.randomUUID(),
        mime: 'image/jpeg',
        dataBase64: fitted.base64,
        createdAt: p.createdAt || new Date().toISOString(),
        kind: p.kind || 'box',
      });
    } catch (err) {
      skipped += 1;
      errors.push(String(err?.message || err));
      console.warn('buildPhotosInline:', err);
    }
  }
  return { inline, skipped, errors };
}

function humanSyncError(err) {
  const code = err?.code || '';
  const msg = String(err?.message || err || '');
  if (code === 'permission-denied' || /permission/i.test(msg)) {
    return 'Sem permissão no Firestore. Verifique as regras no Console Firebase.';
  }
  if (code === 'unavailable' || /network|offline|Failed to fetch/i.test(msg)) {
    return 'Sem rede ou Firebase indisponível. Tente de novo.';
  }
  if (/exceeds|too large|size|1 MiB|1048576/i.test(msg)) {
    return 'Foto ainda grande demais para a nuvem (limite Firestore).';
  }
  return msg.slice(0, 160) || 'Falha ao enviar foto para a nuvem.';
}

/**
 * Grava foto na subcoleção Firestore em chunks (não usa Storage).
 * Comprime agressivamente antes. Metadados sem base64 completo.
 * @returns {{ ok: true, chunkCount: number } | { ok: false, reason: string, message?: string } | null}
 */
export async function syncUploadPhoto(recordId, photoId, blob, meta = {}) {
  if (!isSyncActive() || !recordId || !photoId || !blob) return null;

  let fitted;
  try {
    fitted = await compressUntilFit(blob);
  } catch (err) {
    return { ok: false, reason: 'compress_error', message: humanSyncError(err) };
  }
  if (!fitted.ok) {
    return {
      ok: false,
      reason: 'too_large',
      message:
        'Foto ainda grande demais para a nuvem mesmo após comprimir. Ficou só neste aparelho. Use uma foto menor.',
    };
  }

  const dataBase64 = fitted.base64;
  const totalChars = dataBase64.length;
  const chunkCount = Math.max(1, Math.ceil(totalChars / PHOTO_CHUNK_CHARS));

  try {
    const { doc, setDoc, collection, getDocs, deleteDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'
    );

    // Limpar chunks antigos (reenvio / migração)
    try {
      const oldChunks = await getDocs(
        collection(db, FIRESTORE_COLLECTION, recordId, 'fotos', photoId, 'chunks')
      );
      await Promise.all(oldChunks.docs.map((d) => deleteDoc(d.ref)));
    } catch (_) {}

    const payload = {
      id: photoId,
      kind: meta.kind || 'box',
      createdAt: meta.createdAt || new Date().toISOString(),
      mime: 'image/jpeg',
      chunkCount,
      totalChars,
    };
    // Sem dataBase64 no meta (chunked) — replace completo limpa legado inline
    await setDoc(doc(db, FIRESTORE_COLLECTION, recordId, 'fotos', photoId), payload);

    for (let i = 0; i < chunkCount; i++) {
      const start = i * PHOTO_CHUNK_CHARS;
      const slice = dataBase64.slice(start, start + PHOTO_CHUNK_CHARS);
      await setDoc(
        doc(db, FIRESTORE_COLLECTION, recordId, 'fotos', photoId, 'chunks', String(i)),
        { i, data: slice }
      );
    }
    return { ok: true, chunkCount };
  } catch (err) {
    console.warn('syncUploadPhoto:', err);
    return { ok: false, reason: 'upload_error', message: humanSyncError(err) };
  }
}

export async function syncDeletePhoto(recordId, photoId) {
  if (!isSyncActive() || !recordId || !photoId) return;
  try {
    await deletePhotoDocDeep(recordId, photoId);
  } catch (err) {
    console.warn('Falha ao apagar foto no Firestore:', err);
    throw err;
  }
}

/**
 * Lê embalagens/{recordId}/fotos (+ chunks) e devolve { id, kind, createdAt, mime, blob }[].
 * Compatível com docs legados que ainda têm dataBase64 inline.
 */
export async function syncPullPhotos(recordId) {
  if (!isSyncActive() || !recordId) return [];
  try {
    const { collection, getDocs, doc, getDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'
    );
    const snap = await getDocs(collection(db, FIRESTORE_COLLECTION, recordId, 'fotos'));
    const list = [];

    for (const d of snap.docs) {
      const data = d.data() || {};
      const mime = data.mime || 'image/jpeg';
      const photoId = data.id || d.id;
      let b64 = '';

      if (data.dataBase64 && typeof data.dataBase64 === 'string') {
        // Legado: base64 inline no documento
        b64 = data.dataBase64;
      } else {
        const chunkCount = Number(data.chunkCount) || 0;
        if (chunkCount > 0) {
          const parts = new Array(chunkCount).fill('');
          const chunksSnap = await getDocs(
            collection(db, FIRESTORE_COLLECTION, recordId, 'fotos', photoId, 'chunks')
          );
          chunksSnap.forEach((cd) => {
            const c = cd.data() || {};
            const idx = Number(c.i ?? cd.id);
            if (Number.isFinite(idx) && idx >= 0 && idx < chunkCount && typeof c.data === 'string') {
              parts[idx] = c.data;
            }
          });
          // Fallback: se faltou algum chunk, tentar getDoc individual
          for (let i = 0; i < chunkCount; i++) {
            if (parts[i]) continue;
            try {
              const cref = await getDoc(
                doc(db, FIRESTORE_COLLECTION, recordId, 'fotos', photoId, 'chunks', String(i))
              );
              if (cref.exists()) {
                const c = cref.data() || {};
                if (typeof c.data === 'string') parts[i] = c.data;
              }
            } catch (_) {}
          }
          if (parts.some((p) => !p)) {
            console.warn('syncPullPhotos: chunks incompletos para', photoId);
            continue;
          }
          b64 = parts.join('');
        }
      }

      if (!b64) continue;
      list.push({
        id: photoId,
        kind: data.kind || 'box',
        createdAt: data.createdAt || '',
        mime,
        blob: rawBase64ToBlob(b64, mime),
      });
    }

    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return list;
  } catch (err) {
    console.warn('syncPullPhotos:', err);
    throw err;
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
