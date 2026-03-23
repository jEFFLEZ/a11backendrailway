[![Activate CI](https://github.com/jEFFLEZ/qflush/actions/workflows/activate-ci.yml/badge.svg)](https://github.com/jEFFLEZ/qflush/actions/workflows/activate-ci.yml)

# QFLUSH — Orchestrateur Funesterie

**Version 3.1.5**

---

## Présentation
QFLUSH est l'orchestrateur principal du projet Funesterie. Il gère les flux, pipelines, et services (CLI + daemon) pour automatiser et superviser les traitements complexes (indexation, encodage, IA, etc.).

---

## Modules principaux

- **Daemon** : Serveur HTTP principal (`src/daemon/qflushd.ts`), endpoints NPZ, Rome, admin, orchestration.
- **Rome** : Moteur d'indexation, règles, actions (`src/rome/`).
- **Beam** : Pipelines DBZ (stream, ciblage, batch, fusion, ultra) via [@funeste38/beam](https://www.npmjs.com/package/@funeste38/beam).
- **Cortex** : Encodage OC8, IA, compression, brotli, OC8, NPZ (`src/cortex/`).
- **Nezlephant** : Extraction, analyse, parsing avancé (`src/nezlephant/`).
- **OC8** : Format d'encodage optimisé, compression, mapping, brotli (`src/cortex/oc8.ts`).
- **Brotli** : Compression/décompression, support natif et via Cortex.
- **Spyder** : Webs, admin, gestion des ports, endpoints (`src/spyder/`).
- **FS virtuel** : Abstraction filesystem, support in-memory et Redis.
- **Redis** : Stockage clé-valeur, fallback in-memory.
- **CLI** : Commandes utilisateur (`src/commands/`).
- **Utils** : Helpers, outils, secrets, fetch, hmac, etc. (`src/utils/`).

---

## Architecture & Organisation
```
qflush/
  src/
    daemon/        # Serveur principal, endpoints
    rome/          # Moteur d'indexation, logique
    beam/          # Pipelines Funesterie (si local)
    cortex/        # Encodage, OC8, IA, brotli
    nezlephant/    # Extraction, analyse
    spyder/        # Webs, admin
    commands/      # Commandes CLI
    utils/         # Helpers, outils
  dist/            # Build compilé (non commité)
  .qflush/         # Configs projet, cache, etc.
  docs/            # Documentation, quick-start
```

---

## Commandes de base (CLI)

### Installation des dépendances
```sh
npm ci --no-audit --no-fund
```

### Compilation TypeScript
```sh
npm run build
```

### Lancement du daemon
```sh
npm start
# ou
node dist/daemon/qflushd.js
```

### Lancer les tests
```sh
npm test
```

### Commandes avancées
- **Afficher l’aide CLI** :
  ```sh
  npx qflush --help
  ```
- **Démarrer A-11 (IA locale)** :
  ```sh
  npx qflush start a11
  ```
- **Vérifier le statut A-11** :
  ```sh
  npx qflush a11:status
  ```
- **Lister les endpoints NPZ** :
  ```sh
  curl "http://localhost:4500/npz/checksum/list"
  ```

---

## Pipelines Funesterie (Module Beam)
QFLUSH orchestre des pipelines typés DBZ via [@funeste38/beam](https://www.npmjs.com/package/@funeste38/beam) :

| Type      | Alias DBZ         | Description                       |
|-----------|-------------------|-----------------------------------|
| `beam`    | `kamehameha`      | Flux continu, streaming           |
| `drill`   | `makankosappo`    | Ciblage précis                    |
| `bomb`    | `genkidama`       | Batch massif, agrégation          |
| `fusion`  | `gogeta`          | Pipeline hybride (multi-phase)    |
| `ultra`   | `ssj`, `god`      | Pipeline ultime, auto-optimisé    |

Exemple d'utilisation :
```typescript
import { runQflushBeam } from "@funeste38/beam";
const result = await runQflushBeam({
  type: "gogeta",
  source: "qflush:smartchain",
  target: "cortex:/encode",
  payload: { file: "D:/img.png" }
});
```

---

## Cortex, OC8, Brotli, Nezlephant
- **Cortex** : Encodage OC8, IA, compression brotli, NPZ, mapping, hashing, analyse d'image, support multi-format.
- **OC8** : Format d'encodage optimisé pour la compression et le mapping, utilisé dans Cortex et Beam.
- **Brotli** : Compression/décompression, utilisé pour les dumps, les assets, et les pipelines.
- **Nezlephant** : Extraction, parsing, analyse avancée de fichiers, intégration dans les pipelines et Cortex.

Exemple d'utilisation Cortex :
```typescript
import { encodeOC8, decodeOC8 } from "./cortex/oc8";
const encoded = encodeOC8(buffer);
const decoded = decodeOC8(encoded);
```

---

## Endpoints API (NPZ, Rome, Spyder)
- Stocker un checksum : `/npz/checksum/store`
- Lister les checksums : `/npz/checksum/list`
- Vérifier un checksum : `/npz/checksum/verify`
- Nettoyer les checksums : `/npz/checksum/clear`
- Index Rome : `/npz/rome-index`
- Endpoints Spyder admin : `/spyder/admin/*`

Exemples :
```bash
curl -X POST "http://localhost:4500/npz/checksum/store" -H "Content-Type: application/json" -d '{"id":"t1","checksum":"abc","ttlMs":60000}'
curl "http://localhost:4500/npz/checksum/list"
curl -X POST "http://localhost:4500/npz/checksum/verify" -H "Content-Type: application/json" -d '{"id":"t1","checksum":"abc"}'
curl -X DELETE "http://localhost:4500/npz/checksum/clear"
curl "http://localhost:4500/npz/rome-index"
```

---

## Configuration
- Variables d'environnement : `QFLUSHD_PORT`, `QFLUSH_ENABLE_REDIS`, `QFLUSH_DISABLE_COPILOT`, etc.
- Fichiers de config : `.qflush/spyder.config.json`, `.qflush/a11.config.json`, `.qflush/logic-config.json`

Exemple de config A-11 :
```json
{
  "enabled": true,
  "path": "D:/projects/a11",
  "startCommand": "pwsh -File start-a11-system.ps1",
  "healthUrl": "http://127.0.0.1:3000/health",
  "pidFile": ".qflush/a11.pid"
}
```

---

## Build & Conventions
- TypeScript : `rootDir: "src"`, `outDir: "dist"`
- Les artefacts build (`dist/`) ne doivent pas être commités.
- Compatible ESM + CJS (NodeNext)
- Scripts CI/CD intégrés (GitHub Actions)

---

## Contribution & Bonnes pratiques
- Forkez le repo, créez une branche, ouvrez une PR.
- Respectez les conventions ESM/CJS (voir section dédiée).
- Ajoutez vos exemples d'API ou pipelines dans `docs/quick-start.md`.
- Utilisez les scripts CI pour valider la build et les tests.

---

## Liens utiles
- [Documentation rapide](docs/quick-start.md)
- [Module Beam sur npm](https://www.npmjs.com/package/@funeste38/beam)
- [Repo GitHub](https://github.com/jEFFLEZ/qflush)

---

## Licence
MIT

---

# QFLUSH — Manuel d’utilisation

**Version 3.1.5**

---

## 1. Installation

### Prérequis
- Node.js >= 18
- npm >= 9

### Installation des dépendances
```sh
npm ci --no-audit --no-fund
```

### Compilation TypeScript
```sh
npm run build
```

---

## 2. Démarrage du daemon

### Lancer le serveur principal
```sh
npm start
# ou
node dist/daemon/qflushd.js
```

Le daemon démarre sur le port 4500 par défaut (modifiable via la variable d’environnement `QFLUSHD_PORT`).

---

## 3. Commandes CLI principales

- **Afficher l’aide**
  ```sh
  npx qflush --help
  ```
- **Lancer un pipeline Funesterie (Beam, Drill, Bomb, Fusion, Ultra)**
  ```sh
  npx qflush beam --type kamehameha --source repo:/ --target cortex:/encode
  ```
- **Démarrer A-11 (IA locale)**
  ```sh
  npx qflush start a11
  ```
- **Vérifier le statut A-11**
  ```sh
  npx qflush a11:status
  ```

---

## 4. Utilisation des endpoints API

- **Stocker un checksum**
  ```sh
  curl -X POST "http://localhost:4500/npz/checksum/store" -H "Content-Type: application/json" -d '{"id":"t1","checksum":"abc","ttlMs":60000}'
  ```
- **Lister les checksums**
  ```sh
  curl "http://localhost:4500/npz/checksum/list"
  ```
- **Vérifier un checksum**
  ```sh
  curl -X POST "http://localhost:4500/npz/checksum/verify" -H "Content-Type: application/json" -d '{"id":"t1","checksum":"abc"}'
  ```
- **Nettoyer les checksums**
  ```sh
  curl -X DELETE "http://localhost:4500/npz/checksum/clear"
  ```
- **Index Rome**
  ```sh
  curl "http://localhost:4500/npz/rome-index"
  ```

---

## 5. Pipelines Funesterie (Beam)

QFLUSH orchestre des pipelines typés DBZ via [@funeste38/beam](https://www.npmjs.com/package/@funeste38/beam) :

| Type      | Alias DBZ         | Description                       |
|-----------|-------------------|-----------------------------------|
| `beam`    | `kamehameha`      | Flux continu, streaming           |
| `drill`   | `makankosappo`    | Ciblage précis                    |
| `bomb`    | `genkidama`       | Batch massif, agrégation          |
| `fusion`  | `gogeta`          | Pipeline hybride (multi-phase)    |
| `ultra`   | `ssj`, `god`      | Pipeline ultime, auto-optimisé    |

Exemple d’utilisation dans le code :
```typescript
import { runQflushBeam } from "@funeste38/beam";
const result = await runQflushBeam({
  type: "gogeta",
  source: "qflush:smartchain",
  target: "cortex:/encode",
  payload: { file: "D:/img.png" }
});
```

---

## 6. Configuration

- Variables d’environnement :
  - `QFLUSHD_PORT` : port du daemon
  - `QFLUSH_ENABLE_REDIS` : activer Redis
  - `QFLUSH_DISABLE_COPILOT` : désactiver Copilot
- Fichiers de config :
  - `.qflush/spyder.config.json` : config Spyder
  - `.qflush/a11.config.json` : config IA locale
  - `.qflush/logic-config.json` : logique avancée

Exemple de config A-11 :
```json
{
  "enabled": true,
  "path": "D:/projects/a11",
  "startCommand": "pwsh -File start-a11-system.ps1",
  "healthUrl": "http://127.0.0.1:3000/health",
  "pidFile": ".qflush/a11.pid"
}
```

---

## 7. Modules avancés

- **Cortex** : Encodage OC8, IA, compression brotli, NPZ, mapping, hashing, analyse d'image, support multi-format.
- **OC8** : Format d'encodage optimisé pour la compression et le mapping, utilisé dans Cortex et Beam.
- **Brotli** : Compression/décompression, utilisé pour les dumps, les assets, et les pipelines.
- **Nezlephant** : Extraction, parsing, analyse avancée de fichiers, intégration dans les pipelines et Cortex.
- **Spyder** : Webs, admin, gestion des ports, endpoints.
- **FS virtuel** : Abstraction filesystem, support in-memory et Redis.

---

## 8. Bonnes pratiques & contribution

- Forkez le repo, créez une branche, ouvrez une PR.
- Respectez les conventions ESM/CJS (voir section dédiée).
- Ajoutez vos exemples d'API ou pipelines dans `docs/quick-start.md`.
- Utilisez les scripts CI pour valider la build et les tests.

---

## 9. Liens utiles
- [Documentation rapide](docs/quick-start.md)
- [Module Beam sur npm](https://www.npmjs.com/package/@funeste38/beam)
- [Repo GitHub](https://github.com/jEFFLEZ/qflush)

---

## 10. Licence
MIT
