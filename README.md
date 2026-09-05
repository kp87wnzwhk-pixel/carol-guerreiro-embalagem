# Carol Guerreiro Importado — Embalagem

App **estático** (PWA mobile-first) para registrar caixas embaladas no armazém.

**Slogan:** *No Brasil é luxo, com a Carol é barato.*

- Lista de caixas com busca por nome/telefone
- Medidas (C × L × A em cm), peso (kg + g), fotos, observações
- PIN da equipe (padrão temporário: **`2026`**)
- Backup JSON (exportar / importar)
- Pronto para Firebase Firestore + Storage (desligado por padrão)

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

## Modo local (padrão)

Com `SYNC_ENABLED = false` em `js/firebase-config.js`:

- Metadados das caixas → `localStorage`
- Fotos → IndexedDB
- Funciona offline em **um** aparelho

A lista começa **vazia** (sem clientes inventados).

## Sincronização multi-aparelho (Firebase)

1. Crie um projeto gratuito em [Firebase Console](https://console.firebase.google.com)
2. Ative **Firestore Database** (modo produção ou teste; ajuste as regras)
3. Ative **Storage**
4. Em Configurações do projeto → Seus apps → Web: copie o objeto `firebaseConfig`
5. Cole em `js/firebase-config.js` e defina:

```js
export const SYNC_ENABLED = true;
```

6. Coleção Firestore: `embalagens`  
   Fotos no Storage: `embalagens/{id}/…`

### Regras sugeridas (teste / equipe pequena)

O app usa PIN no cliente — **não** substitui autenticação Firebase. Para produção, prefira Auth + regras por usuário. Em teste rápido (só equipe interna):

**Firestore**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /embalagens/{doc} {
      allow read, write: if true; // TROQUE por Auth em produção
    }
  }
}
```

**Storage**

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

## GitHub Pages

1. Suba a pasta para um repositório GitHub
2. **Settings → Pages** → branch `main` / pasta `/ (root)`
3. Abra `https://<usuario>.github.io/<repo>/`
4. No celular: **Adicionar à tela inicial** (PWA)

## Backup

- **Exportar JSON**: metadados + fotos pequenas em base64 (best-effort). Fotos grandes permanecem no aparelho.
- **Importar JSON**: mescla por `id` (atualiza se o importado for mais recente).

## Estrutura

```
index.html
css/styles.css
js/app.js
js/config.js          ← TEAM_PIN
js/storage.js
js/db.js              ← IndexedDB fotos
js/sync.js
js/firebase-config.js ← SYNC_ENABLED + credenciais
manifest.json
sw.js
icons/
README.md
```

## Privacidade

Telefones e fotos ficam no navegador (e no Firebase se a sync estiver ligada). Use HTTPS em produção e restrinja as regras do Firebase.
