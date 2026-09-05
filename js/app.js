/**
 * Carol Guerreiro Importado — Embalagem (PWA mobile-first)
 */
import { TEAM_PIN, APP_NAME, SLOGAN } from './config.js';
import {
  loadRecords,
  saveRecords,
  searchRecords,
  formatPhoneBR,
  phoneDigits,
  waLink,
  weightToGrams,
  gramsToKgG,
  formatWeight,
  formatMeasures,
  formatDateBR,
  formatTimeHM,
  normalizeRecord,
  getEffectivePin,
  setPinOverride,
  isSessionUnlocked,
  setSessionUnlocked,
  getSavedNickname,
  setSavedNickname,
  pushAutoBackup,
  listAutoBackups,
  restoreFromAutoBackup,
  getDurabilityStatus,
  getLastSaveAt,
  peekRecoveryBanner,
  clearRecoveryBanner,
  backupFilename,
  todayLocalISO,
  tomorrowLocalISO,
  parseWorkDate,
  formatWorkDateBR,
  formatWorkDateSectionTitle,
  groupRecordsByWorkDate,
} from './storage.js';
import {
  addPhoto,
  listPhotosForRecord,
  deletePhoto,
  deleteAllPhotosForRecord,
  photoObjectURL,
  blobToDataURL,
  dataURLToBlob,
} from './db.js';
import {
  initSync,
  isSyncActive,
  getSyncStatus,
  syncUpsertRecord,
  syncDeleteRecord,
  syncPullAll,
  syncUploadPhoto,
  syncDeletePhoto,
  syncPullPhotos,
  compressImageBlob,
  subscribeRecords,
} from './sync.js';

let records = [];
let objectUrls = [];
let pendingPhotoBlobs = []; // blobs ainda não gravados (formulário novo)
let currentView = 'pin'; // pin | home | form | detail | settings | backup
let editingId = null;
let detailId = null;
let searchQuery = '';
let dayFilter = 'all'; // 'all' | 'today' | 'tomorrow' — chips na home
let recoveryBanner = null; // one-time after boot recovery

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function revokeUrls() {
  for (const u of objectUrls) {
    try { URL.revokeObjectURL(u); } catch (_) {}
  }
  objectUrls = [];
}

function trackUrl(u) {
  objectUrls.push(u);
  return u;
}

function persistLocal() {
  records = saveRecords(records);
}

function getRecord(id) {
  return records.find((r) => r.id === id) || null;
}

function toast(msg, type = '', ms = 3200) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('show');
  }, ms);
}

function downloadBlob(filename, blob) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Metadata-only backup (small) — records + photoCount, sem fotos base64. */
function buildMetadataPayload() {
  return {
    app: 'carol-guerreiro-embalagem',
    kind: 'metadata',
    exportedAt: new Date().toISOString(),
    recordCount: records.length,
    records: records.map((r) => ({
      ...r,
      photoCount: Number(r.photoCount) || 0,
    })),
  };
}

function downloadMetadataBackup() {
  const payload = buildMetadataPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(backupFilename(new Date()), blob);
}

/**
 * Após create/edit bem-sucedido:
 * auto-backup silencioso + toast + download metadata JSON.
 */
function afterSuccessfulSave() {
  const result = pushAutoBackup(records);
  const n = result?.n ?? listAutoBackups().length;
  try {
    downloadMetadataBackup();
  } catch (err) {
    console.warn('Auto-download backup:', err);
  }
  toast(`Salvo no aparelho ✓ · Backup automático #${n}`, 'ok', 4000);
}

/* ---------- PIN ---------- */
function tryUnlock(pinInput) {
  const effective = getEffectivePin(TEAM_PIN);
  if (String(pinInput) === String(effective)) {
    setSessionUnlocked(true);
    return true;
  }
  return false;
}

function requireUnlock() {
  if (isSessionUnlocked()) return true;
  currentView = 'pin';
  render();
  return false;
}

/* ---------- Merge remote ---------- */
function mergeRemoteIntoLocal(remote) {
  if (!Array.isArray(remote)) return false;
  const map = new Map(records.map((r) => [r.id, r]));
  let changed = false;
  for (const r of remote) {
    const n = normalizeRecord(r);
    if (!n) continue;
    const local = map.get(n.id);
    if (!local || String(n.updatedAt) > String(local.updatedAt)) {
      map.set(n.id, n);
      changed = true;
    }
  }
  if (changed) {
    records = [...map.values()];
    persistLocal();
  }
  return changed;
}

async function maybePullRemote() {
  if (!isSyncActive()) return;
  try {
    const remote = await syncPullAll();
    if (!remote) return;
    mergeRemoteIntoLocal(remote);
  } catch (err) {
    console.warn('Pull remoto falhou:', err);
  }
}

/**
 * Puxa fotos remotas (Firestore) e grava no IndexedDB se ainda não existirem.
 */
async function hydratePhotosForRecord(recordId) {
  if (!isSyncActive() || !recordId) return [];
  try {
    const remote = await syncPullPhotos(recordId);
    if (!remote.length) return listPhotosForRecord(recordId);
    const local = await listPhotosForRecord(recordId);
    const localIds = new Set(local.map((p) => p.id));
    for (const p of remote) {
      if (!p?.blob || localIds.has(p.id)) continue;
      await addPhoto(recordId, p.blob, {
        id: p.id,
        createdAt: p.createdAt,
        kind: p.kind,
        mime: p.mime || 'image/jpeg',
      });
      localIds.add(p.id);
    }
    return listPhotosForRecord(recordId);
  } catch (err) {
    console.warn('hydratePhotosForRecord:', err);
    return listPhotosForRecord(recordId);
  }
}

let unsubRecords = null;

function startRealtimeSync() {
  if (unsubRecords) {
    try { unsubRecords(); } catch (_) {}
    unsubRecords = null;
  }
  if (!isSyncActive()) return;
  unsubRecords = subscribeRecords((remote) => {
    const changed = mergeRemoteIntoLocal(remote);
    if (!changed) return;
    // Não interromper formulário no meio da edição
    if (currentView === 'form') return;
    if (currentView === 'detail' && detailId) {
      // Re-render + hydrate fotos do detalhe visível
      render();
      return;
    }
    if (currentView === 'home' || currentView === 'detail') {
      render();
    }
  });
}

/* ---------- Render shell ---------- */
function render() {
  revokeUrls();
  const root = $('#app');
  if (!root) return;

  if (!isSessionUnlocked()) {
    currentView = 'pin';
    root.innerHTML = renderPin();
    bindPin();
    return;
  }

  switch (currentView) {
    case 'form':
      root.innerHTML = renderForm();
      bindForm();
      break;
    case 'detail':
      root.innerHTML = renderDetailShell();
      bindDetail();
      break;
    case 'settings':
      root.innerHTML = renderSettings();
      bindSettings();
      break;
    case 'backup':
      root.innerHTML = renderBackup();
      bindBackup();
      break;
    default:
      currentView = 'home';
      root.innerHTML = renderHome();
      bindHome();
      break;
  }
}

function headerHtml(opts = {}) {
  const { showBack = false, title = null, showSettings = false } = opts;
  return `
    <header class="app-header ${opts.compact ? 'compact' : ''}">
      <div class="header-bar">
        ${showBack ? `<button type="button" class="btn-icon" id="btn-back" aria-label="Voltar">←</button>` : '<span class="header-spacer"></span>'}
        <div class="header-center">
          ${!opts.compact ? `
            <div class="logo-wrap" aria-hidden="true">
              <img src="icons/logo.svg" alt="" class="logo" width="64" height="64" />
            </div>
            <h1 class="brand">${APP_NAME}</h1>
            <p class="slogan">${SLOGAN}</p>
          ` : `<h1 class="brand brand-sm">${title || 'Embalagem'}</h1>`}
        </div>
        ${showSettings ? `<button type="button" class="btn-icon" id="btn-settings" aria-label="Configurações">⚙</button>` : '<span class="header-spacer"></span>'}
      </div>
      ${opts.subtitle ? `<p class="screen-subtitle">${opts.subtitle}</p>` : ''}
      ${opts.statusLine ? `<p class="durability-status" id="home-save-status">${opts.statusLine}</p>` : ''}
    </header>
  `;
}

function homeStatusLine() {
  const last = getLastSaveAt();
  const hm = last ? formatTimeHM(last) : '—';
  return `${records.length} caixa${records.length === 1 ? '' : 's'} · último save ${hm}`;
}

/* ---------- PIN screen ---------- */
function renderPin() {
  return `
    <div class="screen pin-screen">
      ${headerHtml({})}
      <section class="card pin-card">
        <h2 class="card-title">Acesso da equipe</h2>
        <p class="hint">Digite o PIN para abrir o registro de embalagens.</p>
        <div class="form-row">
          <label for="pin-input">PIN</label>
          <input type="password" id="pin-input" inputmode="numeric" autocomplete="one-time-code"
            maxlength="12" placeholder="••••" />
        </div>
        <p class="hint err" id="pin-error" hidden></p>
        <button type="button" class="btn btn-primary btn-lg btn-block" id="btn-unlock">Entrar</button>
      </section>
    </div>
  `;
}

function bindPin() {
  const input = $('#pin-input');
  const err = $('#pin-error');
  const go = () => {
    const v = (input?.value || '').trim();
    if (!v) {
      err.hidden = false;
      err.textContent = 'Informe o PIN.';
      return;
    }
    if (tryUnlock(v)) {
      err.hidden = true;
      currentView = 'home';
      render();
      return;
    }
    if (input) input.value = '';
    err.hidden = false;
    err.textContent = 'PIN incorreto. Sem acesso aos dados.';
    input?.focus();
  };
  $('#btn-unlock')?.addEventListener('click', go);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  });
  setTimeout(() => input?.focus(), 50);
}

/* ---------- Home ---------- */
function listItemHtml(r) {
  return `
      <div class="list-card" data-id="${r.id}">
        <button type="button" class="list-item" data-open-detail="${r.id}">
          <strong>${escapeHtml(r.clientName || 'Sem nome')}</strong>
          <span class="list-meta">${escapeHtml(r.phone || '')}</span>
          <span class="list-meta">${escapeHtml(formatMeasures(r))} · ${escapeHtml(formatWeight(r.weightGrams))}</span>
          <span class="list-meta muted">${escapeHtml(formatDateBR(r.createdAt))}</span>
        </button>
        <button type="button" class="btn btn-outline btn-sm list-edit-btn" data-edit-id="${r.id}" aria-label="Editar caixa">
          Editar
        </button>
      </div>`;
}

function openEditForm(id) {
  editingId = id;
  pendingPhotoBlobs = [];
  currentView = 'form';
  render();
  if (isSyncActive() && id) {
    hydratePhotosForRecord(id).then(() => {
      if (currentView === 'form' && editingId === id) refreshPhotoPreview();
    });
  }
}

function filteredHomeRecords() {
  let list = searchRecords(records, searchQuery);
  if (dayFilter === 'today') {
    const t = todayLocalISO();
    list = list.filter((r) => r.workDate === t);
  } else if (dayFilter === 'tomorrow') {
    const t = tomorrowLocalISO();
    list = list.filter((r) => r.workDate === t);
  }
  return list;
}

function renderGroupedListHtml(list) {
  if (!list.length) {
    return `<p class="empty-state">${
      searchQuery || dayFilter !== 'all'
        ? 'Nenhuma caixa encontrada.'
        : 'Nenhuma caixa embalada ainda. Toque em “Nova caixa”.'
    }</p>`;
  }
  const groups = groupRecordsByWorkDate(list);
  return groups
    .map((g) => {
      const count = g.records.length;
      const countLabel = `${count} caixa${count === 1 ? '' : 's'}`;
      return `
      <section class="day-section" data-work-date="${escapeAttr(g.workDate)}" id="day-${escapeAttr(g.workDate)}">
        <h2 class="day-section-title">
          <span>${escapeHtml(g.title)}</span>
          <span class="day-count">${escapeHtml(countLabel)}</span>
        </h2>
        ${g.records.map(listItemHtml).join('')}
      </section>`;
    })
    .join('');
}

function renderHome() {
  const list = filteredHomeRecords();
  const sync = getSyncStatus();
  const syncLabel =
    sync.mode === 'sync'
      ? 'Nuvem ligada · todos os celulares veem a mesma lista'
      : sync.message;
  const items = renderGroupedListHtml(list);

  const banner = recoveryBanner
    ? `<div class="recovery-banner" role="status" id="recovery-banner">
        Dados recuperados do backup automático
        <button type="button" class="banner-dismiss" id="btn-dismiss-recovery" aria-label="Fechar">✕</button>
      </div>`
    : '';

  const chip = (id, label) =>
    `<button type="button" class="day-chip${dayFilter === id ? ' active' : ''}" data-day-filter="${id}">${label}</button>`;

  return `
    <div class="screen home-screen">
      ${headerHtml({
        showSettings: true,
        subtitle: 'Registro de embalagem',
        statusLine: escapeHtml(homeStatusLine()),
      })}
      ${banner}
      <p class="sync-badge ${sync.mode}">${escapeHtml(syncLabel)}</p>
      <section class="card search-block">
        <label for="search-input" class="card-title">Buscar — nome ou telefone</label>
        <input type="search" id="search-input" placeholder="Ex: Maria, (21) 9…"
          value="${escapeAttr(searchQuery)}" autocomplete="off" />
        <div class="day-chips" role="group" aria-label="Filtrar por dia">
          ${chip('today', 'Hoje')}
          ${chip('tomorrow', 'Amanhã')}
          ${chip('all', 'Todas')}
        </div>
      </section>
      <section class="list-section" id="record-list" aria-live="polite">
        ${items}
      </section>
      <div class="fab-spacer"></div>
      <button type="button" class="fab" id="btn-nova" aria-label="Nova caixa">＋ Nova caixa</button>
      <footer class="app-footer">
        <button type="button" class="btn btn-outline btn-sm" id="btn-goto-backup">Backup</button>
        <span>${records.length} caixa(s)</span>
      </footer>
    </div>
  `;
}

function refreshHomeList() {
  const host = $('#record-list');
  if (!host) return;
  host.innerHTML = renderGroupedListHtml(filteredHomeRecords());
  bindListClicks();
}

function bindHome() {
  $('#btn-settings')?.addEventListener('click', () => {
    currentView = 'settings';
    render();
  });
  $('#btn-nova')?.addEventListener('click', () => {
    editingId = null;
    pendingPhotoBlobs = [];
    currentView = 'form';
    render();
  });
  $('#btn-goto-backup')?.addEventListener('click', () => {
    currentView = 'backup';
    render();
  });
  $('#btn-dismiss-recovery')?.addEventListener('click', () => {
    recoveryBanner = null;
    clearRecoveryBanner();
    const el = $('#recovery-banner');
    if (el) el.remove();
  });
  // One-time: clear session flag after first home paint with banner
  if (recoveryBanner) {
    clearRecoveryBanner();
  }
  $$('[data-day-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dayFilter = btn.dataset.dayFilter || 'all';
      $$('[data-day-filter]').forEach((b) => {
        b.classList.toggle('active', b.dataset.dayFilter === dayFilter);
      });
      refreshHomeList();
      if (dayFilter === 'today' || dayFilter === 'tomorrow') {
        const target =
          dayFilter === 'today' ? todayLocalISO() : tomorrowLocalISO();
        const el = document.getElementById(`day-${target}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
  const search = $('#search-input');
  search?.addEventListener('input', () => {
    searchQuery = search.value;
    refreshHomeList();
  });
  bindListClicks();
}

function bindListClicks() {
  $$('[data-open-detail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      detailId = btn.dataset.openDetail;
      currentView = 'detail';
      render();
    });
  });
  $$('[data-edit-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditForm(btn.dataset.editId);
    });
  });
}

/* ---------- Form ---------- */
function renderForm() {
  const r = editingId ? getRecord(editingId) : null;
  const { kg, g } = r ? gramsToKgG(r.weightGrams) : { kg: 0, g: 0 };
  const nick = r?.createdBy || getSavedNickname();
  return `
    <div class="screen form-screen">
      ${headerHtml({ showBack: true, compact: true, title: r ? 'Editar caixa' : 'Nova caixa' })}
      <form class="card form-card" id="pack-form" novalidate>
        <div class="form-row">
          <label for="f-name">Nome do cliente <span class="required">*</span></label>
          <input type="text" id="f-name" required autocomplete="name"
            value="${escapeAttr(r?.clientName || '')}" placeholder="Nome completo" />
        </div>
        <div class="form-row">
          <label for="f-phone">Telefone <span class="required">*</span></label>
          <input type="tel" id="f-phone" inputmode="tel" required autocomplete="tel"
            placeholder="(21) 99999-0000" value="${escapeAttr(r?.phone || '')}" />
        </div>
        <div class="form-row">
          <label for="f-work-date">Data da caixa</label>
          <input type="date" id="f-work-date" required
            value="${escapeAttr(r?.workDate || todayLocalISO())}" />
        </div>
        <fieldset class="measure-fieldset">
          <legend>Medidas da caixa (cm)</legend>
          <div class="measure-grid">
            <div class="form-row">
              <label for="f-l">Comprimento</label>
              <input type="number" id="f-l" inputmode="decimal" min="0" step="0.1"
                value="${r ? escapeAttr(String(r.measureL)) : ''}" placeholder="cm" />
            </div>
            <div class="form-row">
              <label for="f-w">Largura</label>
              <input type="number" id="f-w" inputmode="decimal" min="0" step="0.1"
                value="${r ? escapeAttr(String(r.measureW)) : ''}" placeholder="cm" />
            </div>
            <div class="form-row">
              <label for="f-h">Altura</label>
              <input type="number" id="f-h" inputmode="decimal" min="0" step="0.1"
                value="${r ? escapeAttr(String(r.measureH)) : ''}" placeholder="cm" />
            </div>
          </div>
        </fieldset>
        <fieldset class="weight-fieldset">
          <legend>Peso</legend>
          <div class="weight-grid">
            <div class="form-row">
              <label for="f-kg">Quilos (kg)</label>
              <input type="number" id="f-kg" inputmode="numeric" min="0" step="1"
                value="${escapeAttr(String(kg))}" />
            </div>
            <div class="form-row">
              <label for="f-g">Gramas (0–999)</label>
              <input type="number" id="f-g" inputmode="numeric" min="0" max="999" step="1"
                value="${escapeAttr(String(g))}" />
            </div>
          </div>
        </fieldset>
        <div class="form-row">
          <label for="f-notes">Observações <span class="optional">(opcional)</span></label>
          <textarea id="f-notes" rows="3" placeholder="Notas…">${escapeHtml(r?.notes || '')}</textarea>
        </div>
        <div class="form-row">
          <label for="f-by">Quem registrou <span class="optional">(apelido)</span></label>
          <input type="text" id="f-by" value="${escapeAttr(nick)}" placeholder="Seu nome / apelido" />
        </div>
        <div class="form-row">
          <span class="card-title" style="margin-bottom:8px;display:block">Fotos</span>
          <div class="btn-row photo-actions">
            <label class="btn btn-secondary btn-lg file-btn">
              📷 Câmera
              <input type="file" id="f-camera" accept="image/*" capture="environment" hidden multiple />
            </label>
            <label class="btn btn-outline btn-lg file-btn">
              🖼 Galeria
              <input type="file" id="f-gallery" accept="image/*" hidden multiple />
            </label>
          </div>
          <div class="photo-preview" id="photo-preview"></div>
        </div>
        <p class="hint err" id="form-error" hidden></p>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary btn-lg" id="btn-cancel-form">Cancelar</button>
          <button type="submit" class="btn btn-primary btn-lg" id="btn-save">Salvar</button>
        </div>
      </form>
    </div>
  `;
}

async function bindForm() {
  $('#btn-back')?.addEventListener('click', () => {
    pendingPhotoBlobs = [];
    if (editingId) {
      detailId = editingId;
      currentView = 'detail';
    } else {
      currentView = 'home';
    }
    render();
  });
  $('#btn-cancel-form')?.addEventListener('click', () => {
    $('#btn-back')?.click();
  });

  const phone = $('#f-phone');
  phone?.addEventListener('input', () => {
    const pos = phone.selectionStart;
    const before = phone.value.length;
    phone.value = formatPhoneBR(phone.value);
    const after = phone.value.length;
    try { phone.setSelectionRange(pos + (after - before), pos + (after - before)); } catch (_) {}
  });

  const gInput = $('#f-g');
  gInput?.addEventListener('input', () => {
    let v = Math.floor(Number(gInput.value) || 0);
    if (v > 999) gInput.value = '999';
    if (v < 0) gInput.value = '0';
  });

  $('#f-camera')?.addEventListener('change', (e) => onPhotosPicked(e));
  $('#f-gallery')?.addEventListener('change', (e) => onPhotosPicked(e));

  await refreshPhotoPreview();

  $('#pack-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveForm();
  });
}

async function onPhotosPicked(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    pendingPhotoBlobs.push(f);
  }
  await refreshPhotoPreview();
}

async function refreshPhotoPreview() {
  const host = $('#photo-preview');
  if (!host) return;
  let html = '';
  if (editingId) {
    try {
      const photos = await listPhotosForRecord(editingId);
      for (const p of photos) {
        const url = trackUrl(photoObjectURL(p));
        html += `
          <div class="thumb" data-saved="${p.id}">
            <img src="${url}" alt="Foto" />
            <button type="button" class="thumb-del" data-del-saved="${p.id}" aria-label="Remover">✕</button>
          </div>`;
      }
    } catch (_) {}
  }
  pendingPhotoBlobs.forEach((blob, i) => {
    const url = trackUrl(URL.createObjectURL(blob));
    html += `
      <div class="thumb" data-pending="${i}">
        <img src="${url}" alt="Nova foto" />
        <button type="button" class="thumb-del" data-del-pending="${i}" aria-label="Remover">✕</button>
      </div>`;
  });
  host.innerHTML = html || '<p class="hint">Nenhuma foto ainda.</p>';
  $$('[data-del-saved]', host).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delSaved;
      await deletePhoto(id);
      try { await syncDeletePhoto(editingId, id); } catch (_) {}
      await refreshPhotoPreview();
      toast('Foto removida');
    });
  });
  $$('[data-del-pending]', host).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.delPending);
      pendingPhotoBlobs.splice(i, 1);
      await refreshPhotoPreview();
    });
  });
}

async function saveForm() {
  const err = $('#form-error');
  const name = ($('#f-name')?.value || '').trim();
  const phoneRaw = ($('#f-phone')?.value || '').trim();
  const digits = phoneDigits(phoneRaw);
  if (!name) {
    err.hidden = false;
    err.textContent = 'Informe o nome do cliente.';
    $('#f-name')?.focus();
    return;
  }
  if (digits.length < 10) {
    err.hidden = false;
    err.textContent = 'Telefone inválido. Use o formato (21) 99999-0000.';
    $('#f-phone')?.focus();
    return;
  }
  err.hidden = true;

  const measureL = Number($('#f-l')?.value) || 0;
  const measureW = Number($('#f-w')?.value) || 0;
  const measureH = Number($('#f-h')?.value) || 0;
  const kg = Number($('#f-kg')?.value) || 0;
  const g = Math.min(999, Math.max(0, Math.floor(Number($('#f-g')?.value) || 0)));
  const notes = ($('#f-notes')?.value || '').trim();
  const createdBy = ($('#f-by')?.value || '').trim();
  setSavedNickname(createdBy);
  const workDate =
    parseWorkDate($('#f-work-date')?.value) || todayLocalISO();

  const now = new Date().toISOString();
  let rec;
  if (editingId) {
    const existing = getRecord(editingId);
    rec = normalizeRecord({
      ...existing,
      clientName: name,
      phone: formatPhoneBR(phoneRaw),
      measureL,
      measureW,
      measureH,
      weightGrams: weightToGrams(kg, g),
      notes,
      createdBy,
      workDate: workDate,
      updatedAt: now,
    });
    records = records.map((r) => (r.id === editingId ? rec : r));
  } else {
    rec = normalizeRecord({
      id: crypto.randomUUID(),
      clientName: name,
      phone: formatPhoneBR(phoneRaw),
      measureL,
      measureW,
      measureH,
      weightGrams: weightToGrams(kg, g),
      notes,
      createdBy,
      workDate: workDate,
      createdAt: now,
      updatedAt: now,
    });
    records.push(rec);
  }

  for (const rawBlob of pendingPhotoBlobs) {
    let blob = rawBlob;
    try {
      blob = (await compressImageBlob(rawBlob, { maxEdge: 1280, quality: 0.7 })) || rawBlob;
    } catch (e) {
      console.warn('Compress foto:', e);
      blob = rawBlob;
    }
    const photoId = await addPhoto(rec.id, blob);
    try {
      if (isSyncActive()) {
        const result = await syncUploadPhoto(rec.id, photoId, blob, {
          createdAt: new Date().toISOString(),
          kind: 'box',
        });
        if (result && result.ok === false && result.reason === 'too_large') {
          toast(
            'Foto ainda grande demais para a nuvem (>~900KB). Ficou só neste aparelho.',
            'err',
            5000
          );
        }
      }
    } catch (e) {
      console.warn('Upload foto:', e);
    }
  }
  pendingPhotoBlobs = [];

  const photos = await listPhotosForRecord(rec.id);
  rec.photoCount = photos.length;
  records = records.map((r) => (r.id === rec.id ? rec : r));
  persistLocal();

  try {
    if (isSyncActive()) await syncUpsertRecord(rec);
  } catch (e) {
    console.warn('Sync upsert:', e);
  }

  afterSuccessfulSave();
  detailId = rec.id;
  editingId = null;
  currentView = 'detail';
  render();
}

/* ---------- Detail ---------- */
function renderDetailShell() {
  const r = getRecord(detailId);
  if (!r) {
    return `
      <div class="screen">
        ${headerHtml({ showBack: true, compact: true, title: 'Detalhe' })}
        <p class="empty-state">Registro não encontrado.</p>
      </div>`;
  }
  return `
    <div class="screen detail-screen">
      ${headerHtml({ showBack: true, compact: true, title: 'Detalhe da caixa' })}
      <section class="card detail-card">
        <button type="button" class="detail-identity" id="btn-edit-identity" aria-label="Editar nome e telefone">
          <h2 class="detail-name">${escapeHtml(r.clientName)}</h2>
          <p class="detail-phone">${escapeHtml(r.phone)}</p>
          <span class="detail-tap-hint">Toque para editar</span>
        </button>
        <button type="button" class="btn btn-primary btn-lg btn-block" id="btn-edit-all">Editar tudo</button>
        <p class="hint edit-hint">Toque em Editar tudo para mudar nome, telefone, medidas, peso e fotos.</p>
        <dl class="detail-dl">
          <div><dt>Medidas</dt><dd>${escapeHtml(formatMeasures(r))}</dd></div>
          <div><dt>Peso</dt><dd>${escapeHtml(formatWeight(r.weightGrams))}</dd></div>
          <div><dt>Data da caixa</dt><dd>${escapeHtml(formatWorkDateSectionTitle(r.workDate))}</dd></div>
          <div><dt>Criado em</dt><dd>${escapeHtml(formatDateBR(r.createdAt))}</dd></div>
          <div><dt>Atualizado</dt><dd>${escapeHtml(formatDateBR(r.updatedAt))}</dd></div>
          ${r.createdBy ? `<div><dt>Por</dt><dd>${escapeHtml(r.createdBy)}</dd></div>` : ''}
          ${r.notes ? `<div class="full"><dt>Observações</dt><dd>${escapeHtml(r.notes)}</dd></div>` : ''}
        </dl>
        <div class="photo-gallery" id="detail-photos"><p class="hint">Carregando fotos…</p></div>
        <div class="move-day-block">
          <p class="card-title" style="margin-bottom:8px">Mover para outro dia</p>
          <div class="btn-row">
            <button type="button" class="btn btn-outline btn-sm" id="btn-move-today">Mover para hoje</button>
            <button type="button" class="btn btn-outline btn-sm" id="btn-move-tomorrow">Mover para amanhã</button>
          </div>
          <div class="form-row" style="margin-top:10px;margin-bottom:0">
            <label for="f-move-date">Escolher outra data…</label>
            <input type="date" id="f-move-date" value="${escapeAttr(r.workDate || todayLocalISO())}" />
          </div>
          <button type="button" class="btn btn-secondary btn-sm btn-block" id="btn-move-custom" style="margin-top:8px">
            Aplicar data escolhida
          </button>
        </div>
        <div class="btn-row stacked">
          <a class="btn btn-whatsapp btn-lg btn-block" id="btn-wa" target="_blank" rel="noopener"
            href="${escapeAttr(waLink(r.phone, r.clientName))}">WhatsApp</a>
          <button type="button" class="btn btn-danger btn-lg btn-block" id="btn-delete">Excluir</button>
        </div>
      </section>
    </div>
  `;
}

function bindDetail() {
  $('#btn-back')?.addEventListener('click', () => {
    currentView = 'home';
    render();
  });
  const r = getRecord(detailId);
  if (!r) return;

  const goEdit = () => openEditForm(r.id);
  $('#btn-edit-all')?.addEventListener('click', goEdit);
  $('#btn-edit-identity')?.addEventListener('click', goEdit);

  $('#btn-delete')?.addEventListener('click', async () => {
    if (!confirm(`Excluir a caixa de ${r.clientName}? Esta ação não pode ser desfeita.`)) return;
    await deleteAllPhotosForRecord(r.id);
    records = records.filter((x) => x.id !== r.id);
    persistLocal();
    try {
      if (isSyncActive()) await syncDeleteRecord(r.id);
    } catch (_) {}
    toast('Caixa excluída');
    detailId = null;
    currentView = 'home';
    render();
  });

  $('#btn-move-today')?.addEventListener('click', () => moveRecordToDate(r.id, todayLocalISO()));
  $('#btn-move-tomorrow')?.addEventListener('click', () =>
    moveRecordToDate(r.id, tomorrowLocalISO())
  );
  $('#btn-move-custom')?.addEventListener('click', () => {
    const picked = parseWorkDate($('#f-move-date')?.value);
    if (!picked) {
      toast('Data inválida', 'err');
      return;
    }
    moveRecordToDate(r.id, picked);
  });

  loadDetailPhotos(r.id);
}

async function moveRecordToDate(id, workDate) {
  const existing = getRecord(id);
  if (!existing) return;
  const target = parseWorkDate(workDate);
  if (!target) {
    toast('Data inválida', 'err');
    return;
  }
  if (existing.workDate === target) {
    toast(`Já está em ${formatWorkDateSectionTitle(target)}`);
    return;
  }
  const now = new Date().toISOString();
  const rec = normalizeRecord({
    ...existing,
    workDate: target,
    updatedAt: now,
  });
  records = records.map((x) => (x.id === id ? rec : x));
  persistLocal();
  try {
    if (isSyncActive()) await syncUpsertRecord(rec);
  } catch (e) {
    console.warn('Sync upsert:', e);
  }
  afterSuccessfulSave();
  detailId = id;
  currentView = 'detail';
  render();
}

async function loadDetailPhotos(recordId) {
  const host = $('#detail-photos');
  if (!host) return;
  try {
    let photos = await listPhotosForRecord(recordId);
    // IndexedDB vazio (ou incompleto): puxar da subcoleção Firestore e hidratar
    if (isSyncActive()) {
      if (!photos.length) {
        photos = await hydratePhotosForRecord(recordId);
      } else {
        // Em background: buscar fotos novas de outros aparelhos
        hydratePhotosForRecord(recordId).then((updated) => {
          if (!updated?.length || updated.length === photos.length) return;
          if (!$('#detail-photos') || detailId !== recordId) return;
          const html = updated
            .map((p) => {
              const url = trackUrl(photoObjectURL(p));
              return `<a class="gallery-item" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Foto da caixa" /></a>`;
            })
            .join('');
          $('#detail-photos').innerHTML = html;
        });
      }
    }
    if (photos.length) {
      host.innerHTML = photos
        .map((p) => {
          const url = trackUrl(photoObjectURL(p));
          return `<a class="gallery-item" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Foto da caixa" /></a>`;
        })
        .join('');
      return;
    }
    host.innerHTML = '<p class="hint">Sem fotos.</p>';
  } catch {
    host.innerHTML = '<p class="hint err">Erro ao carregar fotos.</p>';
  }
}

/* ---------- Settings ---------- */
function renderSettings() {
  const sync = getSyncStatus();
  return `
    <div class="screen settings-screen">
      ${headerHtml({ showBack: true, compact: true, title: 'Configurações' })}
      <section class="card">
        <h2 class="card-title">Alterar PIN</h2>
        <p class="hint">O PIN padrão está em <code>js/config.js</code> (TEAM_PIN). Você também pode gravar um PIN neste aparelho.</p>
        <div class="form-row">
          <label for="pin-current">PIN atual</label>
          <input type="password" id="pin-current" inputmode="numeric" autocomplete="current-password" />
        </div>
        <div class="form-row">
          <label for="pin-new">Novo PIN</label>
          <input type="password" id="pin-new" inputmode="numeric" autocomplete="new-password" />
        </div>
        <div class="form-row">
          <label for="pin-new2">Confirmar novo PIN</label>
          <input type="password" id="pin-new2" inputmode="numeric" autocomplete="new-password" />
        </div>
        <p class="hint err" id="pin-change-err" hidden></p>
        <button type="button" class="btn btn-primary btn-lg btn-block" id="btn-change-pin">Salvar novo PIN</button>
      </section>
      <section class="card">
        <h2 class="card-title">Sincronização</h2>
        <p class="hint">${escapeHtml(sync.message)}</p>
        <p class="hint">Veja o README: fotos vão no Firestore (sem Blaze / Storage opcional).</p>
      </section>
      <section class="card">
        <button type="button" class="btn btn-secondary btn-lg btn-block" id="btn-lock">Bloquear (pedir PIN)</button>
      </section>
    </div>
  `;
}

function bindSettings() {
  $('#btn-back')?.addEventListener('click', () => {
    currentView = 'home';
    render();
  });
  $('#btn-lock')?.addEventListener('click', () => {
    setSessionUnlocked(false);
    currentView = 'pin';
    render();
  });
  $('#btn-change-pin')?.addEventListener('click', () => {
    const err = $('#pin-change-err');
    const cur = ($('#pin-current')?.value || '').trim();
    const n1 = ($('#pin-new')?.value || '').trim();
    const n2 = ($('#pin-new2')?.value || '').trim();
    const effective = getEffectivePin(TEAM_PIN);
    if (cur !== effective) {
      err.hidden = false;
      err.textContent = 'PIN atual incorreto.';
      return;
    }
    if (n1.length < 4) {
      err.hidden = false;
      err.textContent = 'Novo PIN deve ter pelo menos 4 dígitos.';
      return;
    }
    if (n1 !== n2) {
      err.hidden = false;
      err.textContent = 'A confirmação não confere.';
      return;
    }
    setPinOverride(n1);
    err.hidden = true;
    toast('PIN atualizado neste aparelho');
    $('#pin-current').value = '';
    $('#pin-new').value = '';
    $('#pin-new2').value = '';
  });
}

/* ---------- Backup ---------- */
function renderBackup() {
  const st = getDurabilityStatus(records);
  const backups = listAutoBackups();
  const backupItems = backups.length
    ? backups
        .map(
          (b) => `
      <li class="auto-backup-item">
        <div class="auto-backup-meta">
          <strong>${escapeHtml(formatDateBR(b.at))}</strong>
          <span class="muted">${b.count} caixa(s)</span>
        </div>
        <button type="button" class="btn btn-outline btn-sm" data-restore="${escapeAttr(b.id)}">Restaurar</button>
      </li>`
        )
        .join('')
    : '<p class="hint">Nenhum auto-backup ainda. Salve uma caixa para criar.</p>';

  return `
    <div class="screen backup-screen">
      ${headerHtml({ showBack: true, compact: true, title: 'Backup' })}
      <section class="card status-card">
        <h2 class="card-title">Estado neste aparelho</h2>
        <ul class="status-list">
          <li><span>Caixas</span><strong>${st.count}</strong></li>
          <li><span>Último save</span><strong>${escapeHtml(st.lastSaveAt ? formatDateBR(st.lastSaveAt) : '—')}</strong></li>
          <li><span>Último auto-backup</span><strong>${escapeHtml(st.lastAutoBackupAt ? formatDateBR(st.lastAutoBackupAt) : '—')}</strong></li>
        </ul>
        <p class="hint warn-text">Apagar dados do site no Safari (ou limpar cache) apaga o localStorage. Guarde os JSON baixados em Arquivos / iCloud.</p>
      </section>
      <section class="card">
        <h2 class="card-title">Download obrigatório</h2>
        <p class="hint">Baixa só metadados (leve, com photoCount). Guarde o ficheiro fora do navegador.</p>
        <button type="button" class="btn btn-success btn-lg btn-block" id="btn-download-now">
          Baixar backup agora (obrigatório guardar)
        </button>
      </section>
      <section class="card">
        <h2 class="card-title">Backup completo com fotos</h2>
        <p class="hint warn-text">Pode ficar muito grande (fotos em base64). Use só quando precisar de cópia completa.</p>
        <button type="button" class="btn btn-secondary btn-lg btn-block" id="btn-full-photos">
          Backup completo com fotos
        </button>
      </section>
      <section class="card">
        <h2 class="card-title">Auto-backups neste aparelho</h2>
        <p class="hint">Últimos ${backups.length} de até 30 snapshots no localStorage.</p>
        <ul class="auto-backup-list" id="auto-backup-list">
          ${backupItems}
        </ul>
      </section>
      <section class="card">
        <h2 class="card-title">Importar JSON</h2>
        <p class="hint">Mescla registros pelo id (atualiza se o importado for mais recente). Pedirá confirmação.</p>
        <label class="btn btn-secondary btn-lg btn-block file-btn">
          Escolher arquivo…
          <input type="file" id="import-file" accept="application/json,.json" hidden />
        </label>
      </section>
    </div>
  `;
}

function bindBackup() {
  $('#btn-back')?.addEventListener('click', () => {
    currentView = 'home';
    render();
  });
  $('#btn-download-now')?.addEventListener('click', () => {
    downloadMetadataBackup();
    toast('Backup (metadados) baixado — guarde em Arquivos/iCloud', 'ok', 4000);
  });
  $('#btn-full-photos')?.addEventListener('click', () => {
    if (
      !confirm(
        'Backup completo inclui fotos em base64 e pode ficar MUITO grande (vários MB). Continuar?'
      )
    ) {
      return;
    }
    doExportFull();
  });
  $('#import-file')?.addEventListener('change', (e) => doImport(e));
  $$('[data-restore]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.restore;
      if (
        !confirm(
          'Restaurar este auto-backup? Os dados atuais neste aparelho serão substituídos pelos do snapshot.'
        )
      ) {
        return;
      }
      const restored = restoreFromAutoBackup(id);
      if (!restored) {
        toast('Falha ao restaurar', 'err');
        return;
      }
      records = restored;
      toast('Restaurado do auto-backup', 'ok');
      currentView = 'home';
      render();
    });
  });
}

async function doExportFull() {
  const MAX_PHOTO_BYTES = 1_200_000;
  const MAX_TOTAL = 12_000_000;
  let totalEst = 0;
  const photosNote = [];
  const outRecords = [];
  let includePhotos = true;

  for (const r of records) {
    const copy = { ...r, photos: [] };
    if (includePhotos) {
      try {
        const photos = await listPhotosForRecord(r.id);
        for (const p of photos) {
          if (!p.blob) continue;
          if (p.blob.size > MAX_PHOTO_BYTES) {
            photosNote.push(
              `Foto grande omitida em ${r.clientName} (${Math.round(p.blob.size / 1024)} KB)`
            );
            continue;
          }
          if (totalEst + p.blob.size > MAX_TOTAL) {
            photosNote.push(
              'Limite de tamanho do JSON atingido — demais fotos ficam no aparelho.'
            );
            includePhotos = false;
            break;
          }
          const dataUrl = await blobToDataURL(p.blob);
          copy.photos.push({
            id: p.id,
            mime: p.mime,
            createdAt: p.createdAt,
            dataUrl,
          });
          totalEst += p.blob.size;
        }
      } catch (_) {}
    }
    outRecords.push(copy);
  }

  const payload = {
    app: 'carol-guerreiro-embalagem',
    kind: 'full-with-photos',
    exportedAt: new Date().toISOString(),
    records: outRecords,
    notes: photosNote,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(backupFilename(new Date()), blob);
  toast(
    photosNote.length
      ? 'Backup completo baixado (algumas fotos omitidas)'
      : 'Backup completo baixado',
    'ok',
    4000
  );
}

async function doImport(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (
    !confirm(
      `Importar “${file.name}”? Os registros serão mesclados por id (mais recentes vencem).`
    )
  ) {
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(arr)) throw new Error('JSON sem lista de records');
    const map = new Map(records.map((r) => [r.id, r]));
    let added = 0;
    let updated = 0;
    for (const raw of arr) {
      const n = normalizeRecord(raw);
      if (!n || !n.clientName) continue;
      const local = map.get(n.id);
      if (!local) {
        map.set(n.id, n);
        added++;
      } else if (String(n.updatedAt) >= String(local.updatedAt)) {
        map.set(n.id, { ...local, ...n });
        updated++;
      }
      if (Array.isArray(raw.photos)) {
        for (const ph of raw.photos) {
          if (!ph?.dataUrl) continue;
          try {
            const blob = dataURLToBlob(ph.dataUrl);
            await addPhoto(n.id, blob, { id: ph.id, createdAt: ph.createdAt });
          } catch (_) {}
        }
      }
      try {
        if (isSyncActive()) await syncUpsertRecord(map.get(n.id));
      } catch (_) {}
    }
    records = [...map.values()];
    persistLocal();
    pushAutoBackup(records);
    toast(`Importado: ${added} novo(s), ${updated} atualizado(s)`, 'ok');
    currentView = 'home';
    render();
  } catch (err) {
    alert('Falha ao importar: ' + (err.message || err));
  }
}

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/* ---------- boot ---------- */
async function boot() {
  records = loadRecords();
  recoveryBanner = peekRecoveryBanner();
  await initSync();
  await maybePullRemote();
  startRealtimeSync();
  render();

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (err) {
      console.warn('SW:', err);
    }
  }
}

boot();
