# Carol Guerreiro Importado — Embalagem

App **estático** (PWA mobile-first) para registrar caixas embaladas no armazém.

**Slogan:** *No Brasil é luxo, com a Carol é barato.*

- Lista de caixas agrupada por **data da caixa** (Hoje / Amanhã / outros dias) com busca por nome/telefone
- Mover caixas entre dias (hoje, amanhã ou data escolhida)
- Medidas (C × L × A em cm), peso (kg + g), fotos, observações
- PIN da equipe (padrão temporário: **`2026`**)
- Durabilidade local reforçada (espelho + auto-backups + download automático)
- Backup JSON (exportar / importar)
- Sincronização multi-aparelho via **Firestore** (lista + fotos no mesmo documento — **sem** Firebase Storage / sem Blaze)

## Abrir localmente

Use um servidor HTTP (módulos ES — não abra com `file://`).

```bash
npx --yes serve .
# ou
python3 -m http.server 8080
```

## PIN da equipe

- Padrão em `js/config.js`: `TEAM_PIN = '2026'`
- Sobrescrita neste aparelho: chave `localStorage` `cgi_pack_pin`
- Após o PIN correto, a sessão fica desbloqueada (`sessionStorage`) até fechar a aba
- Em **Configurações** (ícone ⚙): alterar PIN (exige o PIN atual) ou bloquear de novo

## Modo local (opcional)

Para forçar só um aparelho, defina `SYNC_ENABLED = false` em `js/firebase-config.js`:

- Metadados das caixas → `localStorage` (chave principal + espelho)
- Auto-backups → até 30 snapshots em `cgi_pack_auto_backups_v1`
- Fotos → IndexedDB
- Funciona offline em **um** aparelho

A lista começa **vazia** (sem clientes inventados).

### Limite honesto do Safari / iPhone

**Apagar dados do site** (Safari → Definições → Avançadas / Dados de sites, ou “Limpar histórico e dados”) **apaga** `localStorage` e IndexedDB deste app. O espelho e os auto-backups **também somem** nesse caso — estão no mesmo armazenamento do navegador.

Por isso o app:

1. Grava em dual-write (`cgi_pack_records_v1` + `cgi_pack_records_mirror_v1`)
2. Mantém histórico de auto-backups no aparelho
3. **Baixa automaticamente um JSON leve** (só metadados / `photoCount`) a cada save — **guarde esse ficheiro em Arquivos / iCloud Drive**
4. Oferece “Backup completo com fotos” (base64) quando precisar de cópia pesada

**Você DEVE guardar os JSON descarregados fora do Safari.** Sem isso, limpar dados do site = perda dos registos locais.

Para **vários aparelhos / nuvem**, configure Firebase (secção abaixo). O modo local sozinho **não** substitui sync multi-dispositivo.

## Durabilidade e backups

| Camada | O quê |
|--------|--------|
| Primary | `cgi_pack_records_v1` |
| Mirror | `cgi_pack_records_mirror_v1` (mesmos dados) |
| Auto-backups | `cgi_pack_auto_backups_v1` — últimos 30 `{ id, at, count, data }` |
| Download automático | A cada create/edit: `carol-embalagem-backup-YYYY-MM-DD-HHmm.json` (metadados) |
| Toast | “Salvo no aparelho ✓ · Backup automático #N” |
| Arranque | Se primary faltar/corromper → restaura mirror ou último auto-backup + banner “Dados recuperados do backup automático” |

Ecrã **Backup**:

- Botão verde **Baixar backup agora (obrigatório guardar)**
- Lista de auto-backups com **Restaurar** (confirmação)
- **Backup completo com fotos** (aviso de tamanho)
- Importar JSON (com confirmação)
- Estado: último save, último auto-backup, contagem

## Sincronização multi-aparelho (Firebase Firestore)

Neste repositório a sync está **ativa** (`SYNC_ENABLED = true` + credenciais do projeto `carol-embalagem`).

**Não precisa de Blaze nem de Firebase Storage.** Registros e fotos ficam no Firestore (plano Spark).

**Obrigatório no Console:** criar **Firestore Database** em **modo de teste** (test mode) se ainda não existir. Sem isso o app local continua a funcionar, mas a nuvem falha (permissões / resource-not-found).

1. Abra [Firebase Console](https://console.firebase.google.com) → projeto `carol-embalagem`
2. Crie **Firestore Database** → escolha **start in test mode**
3. Storage é **opcional** (não usado pelo happy path; pode ignorar)
4. Se o assistente já fechou o modo teste, cole as regras abertas abaixo
5. Coleção: `embalagens` · fotos principais no campo `photosInline` do doc (subcoleção `fotos/` é opcional/legado)

### Fotos na nuvem (caminho principal: `photosInline` no documento)

Os metadados das caixas **já sincronizavam** bem entre celulares. O caminho confiável para fotos é o **mesmo documento** Firestore (`embalagens/{id}`), não a subcoleção:

Campo no registro: **`photosInline`**: até **3** itens `{ id, mime, dataBase64, createdAt, kind }`.

- Cada `dataBase64` ≤ **~280 KiB** (3 × 280 ≈ 840 KiB + campos &lt; limite 1 MiB do Firestore)
- `photoCount` continua no registro
- Ao **salvar** (create/edit), o app **automaticamente** comprime (canvas), monta `photosInline` e faz `setDoc` merge — sem botão extra
- **Backfill automático**: ao abrir o detalhe (e na home após desbloquear / no boot após pull), se o IndexedDB local tiver mais fotos do que `photosInline` remoto, sobe sozinho (debounce por id; concorrência 2 no boot)
- No outro aparelho, o pull/subscribe lê `photosInline`, grava no IndexedDB (`hydrateInlinePhotos`) e mostra a galeria; se o IDB ainda estiver vazio, decodifica o base64 direto para a UI

**Compressão agressiva** (loop no canvas):

1. 1280@0.7 → 2. 960@0.6 → 3. 720@0.55 → 4. 560@0.5 → 5. **480@0.45** → 6. **400@0.4**  
até cada base64 ≤ **280 KiB**. Prefere pelo menos **1 foto de capa** se só uma couber.

Se o upsert inline falhar, o toast mostra o **erro real** (permissão / tamanho / rede).

**Secundário (opcional):** ainda tenta a subcoleção `embalagens/{id}/fotos/{photoId}` + `chunks/` (compatibilidade). O sucesso exigido é o **inline no registro**.

**iPhone / HEIC:** o canvas reencode para JPEG; se a foto não aparecer noutro telemóvel, abra o detalhe (backfill automático) ou use **Reenviar fotos (se falhou)**.

Download automático JSON **leve** omite `photosInline` (só metadados / `photoCount`). O **backup completo com fotos** usa as fotos do IndexedDB.

No **detalhe**:

- Ao abrir, hidrata da nuvem (`Buscando fotos na nuvem…`) e, se faltarem fotos na nuvem, **envia automaticamente** (`Enviando fotos…` → `Fotos sincronizadas`)
- Botão secundário **Reenviar fotos (se falhou)** — retry manual do mesmo pipeline

### Regras sugeridas (teste / equipe pequena)

⚠️ **Aviso de expiração:** regras `allow … if true` e o “test mode” do Firebase **expiram** (tipicamente após ~30 dias no assistente). Depois disso leituras/escritas falham até você renovar as regras ou migrar para Auth. Não use isto em produção pública.

O app usa PIN no cliente — **não** substitui autenticação Firebase. Para produção, prefira Auth + regras por usuário. Em teste rápido (só equipe interna), cole:

**Firestore** (inclui subcoleção `fotos`)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /embalagens/{doc} {
      allow read, write: if true; // TROQUE por Auth em produção
      match /fotos/{photoId} {
        allow read, write: if true;
        match /chunks/{chunkId} {
          allow read, write: if true;
        }
      }
    }
  }
}
```

**Storage (opcional / futuro)** — só se um dia migrar fotos para Storage no Blaze:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /embalagens/{allPaths=**} {
      allow read, write: if true; // TROQUE por Auth em produção
    }
  }
}
```


## Datas das caixas (`workDate`)

Cada registro tem um campo `workDate` (`YYYY-MM-DD`, data local do aparelho) — o **dia de embalagem** na lista.

- Ao criar, o padrão é **hoje** (calendário local; ex. America/Sao_Paulo no aparelho)
- Registros antigos sem o campo usam a data local de `createdAt`
- A home agrupa por dia (Hoje e Amanhã no topo, depois datas mais recentes)
- No detalhe: **Mover para hoje / amanhã / escolher data** (salva + auto-backup + toast)
- Incluído no export/import JSON

## GitHub Pages

1. Suba a pasta para um repositório GitHub
2. **Settings → Pages** → branch `main` / pasta `/ (root)`
3. Abra `https://<usuario>.github.io/<repo>/`
4. No celular: **Adicionar à tela inicial** (PWA)

O service worker usa cache `cgi-pack-v9` (scripts/CSS com `?v=9`). Após deploy o app tenta `skipWaiting` e mostra “Atualizando app…”. Se ficar preso, feche e reabra o PWA.

## Estrutura

```
index.html
css/styles.css
js/app.js
js/config.js          ← TEAM_PIN + STORAGE_KEYS
js/storage.js         ← dual-write, auto-backups, recovery
js/db.js              ← IndexedDB fotos
js/sync.js            ← Firestore (registros + photosInline; chunks secundário)
js/firebase-config.js ← SYNC_ENABLED + credenciais
manifest.json
sw.js                 ← cache cgi-pack-v9
icons/
README.md
```

## Privacidade

Telefones e fotos ficam no navegador (e no Firestore se a sync estiver ligada). Use HTTPS em produção e restrinja as regras do Firebase.
