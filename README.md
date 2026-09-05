# Carol Guerreiro Importado — Embalagem

App **estático** (PWA mobile-first) para registrar caixas embaladas no armazém.

**Slogan:** *No Brasil é luxo, com a Carol é barato.*

- Lista de caixas agrupada por **data da caixa** (Hoje / Amanhã / outros dias) com busca por nome/telefone
- Mover caixas entre dias (hoje, amanhã ou data escolhida)
- Medidas (C × L × A em cm), peso (kg + g), fotos, observações
- PIN da equipe (padrão temporário: **`2026`**)
- Durabilidade local reforçada (espelho + auto-backups + download automático)
- Backup JSON (exportar / importar)
- Sincronização multi-aparelho via **Firestore** (registros **e fotos** — **sem** Firebase Storage / sem Blaze)

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
5. Coleção: `embalagens` · fotos: `embalagens/{recordId}/fotos/{photoId}`

### Fotos na nuvem (Firestore, em pedaços)

Metadados em `embalagens/{recordId}/fotos/{photoId}` **sem** o base64 completo (evita o limite de **1 MiB** por documento):

| Campo | Valor |
|-------|--------|
| `id` | id da foto |
| `kind` | ex. `box` |
| `createdAt` | ISO |
| `mime` | `image/jpeg` |
| `chunkCount` | nº de fatias |
| `totalChars` | tamanho total do base64 |

Chunks em `embalagens/{recordId}/fotos/{photoId}/chunks/{index}`:

| Campo | Valor |
|-------|--------|
| `i` | índice (0…n-1) |
| `data` | fatia de base64 (~400 000 caracteres) |

Docs antigos com `dataBase64` inline ainda são lidos (compatibilidade).

**Compressão agressiva** antes do upload (loop no canvas):

1. 1280px @ 0.7 → 2. 960px @ 0.6 → 3. 720px @ 0.55 → 4. 560px @ 0.5  
até o base64 ficar ≤ **~700 KB** (margem sob 1 MiB). Se ainda for grande demais → toast em português; a foto fica só no IndexedDB.

Falhas de upload (permissão / tamanho / rede) mostram **toast**, não só `console.warn`.

No **detalhe**:

- Ao abrir, **sempre** hidrata da nuvem (`Buscando fotos na nuvem…`) antes de decidir “Sem fotos.”
- Botão **Enviar fotos para a nuvem** reenvia todas as fotos locais do registro (compressão + chunks) — útil se outro aparelho ainda mostrar “Sem fotos.”

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

O service worker usa cache `cgi-pack-v7` — após deploy, feche e reabra o PWA (ou limpe só o cache do SW) para receber a atualização.

## Estrutura

```
index.html
css/styles.css
js/app.js
js/config.js          ← TEAM_PIN + STORAGE_KEYS
js/storage.js         ← dual-write, auto-backups, recovery
js/db.js              ← IndexedDB fotos
js/sync.js            ← Firestore (registros + fotos em chunks)
js/firebase-config.js ← SYNC_ENABLED + credenciais
manifest.json
sw.js                 ← cache cgi-pack-v7
icons/
README.md
```

## Privacidade

Telefones e fotos ficam no navegador (e no Firestore se a sync estiver ligada). Use HTTPS em produção e restrinja as regras do Firebase.
