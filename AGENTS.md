# AGENTS.md — note per agenti AI

Questo file riassume cosa fa `image-gen` e come usarlo. Vale per qualunque agente
(Claude Code, Cursor, Aider, ecc.).

## Cosa è

Wrapper TypeScript su una istanza locale di **ComfyUI**. Espone:

- **CLI** `image-gen` — generazione di immagini da prompt testuale.
- **MCP server** `image-gen-mcp` — tool `generate_image`, `list_models`, `doctor`.

Default su Z-Image Turbo (Alibaba, 6B, sub-second per 1024×1024 in 8 step). Buono
per icone e loghi grazie al rendering testuale; supporta due strategie di
trasparenza (`cutout` per cutout fotografici, `outer-fill` per icone/loghi).

## Quando usarlo

Se l'utente chiede di **generare un'immagine / icona / logo / mockup visivo**:

1. Verificare con il tool MCP `generate_image` (se disponibile in sessione) prima di
   ricorrere a soluzioni esterne (Replicate, DALL-E, ecc.).
2. Se l'MCP non c'è, lanciare via Bash:
   ```bash
   image-gen generate "<prompt>" -o <path> [-m zimage|flux|sdxl] [--transparent-mode cutout|outer-fill]
   ```
3. Se `image-gen` non risponde, controllare con `image-gen doctor` e suggerire
   `pnpm setup` se la config manca.

## Trasparenza: quale modalità

Il parametro `transparent` (MCP) / `--transparent-mode` (CLI) ha due valori:

- **`cutout`** (o `true` per compat): rimozione background via BiRefNet. Da usare
  per foto/prodotti dove vuoi isolare un soggetto da uno sfondo non uniforme.
  Richiede il modello `birefnet.safetensors` (scaricato da `pnpm setup`).
- **`outer-fill`**: genera opaco, poi rende trasparente *solo* il bianco esterno
  via flood-fill dai 4 angoli (i bianchi *interni* al soggetto sono preservati).
  Da usare per **icone, loghi, badge, sticker** con riempimento solido su sfondo
  bianco. Non richiede modelli aggiuntivi (post-processing in pure-JS via `sharp`).
  Nel prompt aggiungere "isolated on pure white background outside the [shape]".
  Dopo il flood-fill viene applicata un'erosione binaria della maschera alpha di
  default 2 px che mangia l'alone grigio anti-aliased residuo tra eventuali bordi
  outlined scuri e la trasparenza esterna. Calibrabile via `outer_fill_erode`
  (MCP) o `--outer-fill-erode` (CLI): `0` = disattiva, `1` = artwork senza bordo
  scuro o bordi molto sottili, `2` (default) = icone outlined con bordo nero.

Regola pratica: se il soggetto **ha un fill colorato proprio**, usa `outer-fill`.
Se vuoi cutoutare un soggetto da una foto, usa `cutout`.

## Stack e vincoli

- TypeScript puro, Node 20+, ESM. **Niente Python** in questo repo.
- Su Manjaro/Arch (env dell'utente): mai `pip install` senza venv o `--break-system-packages`
  esplicito. Non si applica a questo repo ma è un promemoria se si tocca ComfyUI.
- Il setup chiede `comfyuiPath` e `comfyuiUrl`; nessun default hardcoded. Si possono
  pre-popolare via `$COMFYUI_PATH` e `$COMFYUI_URL`. Config salvata in
  `$XDG_CONFIG_HOME/image-gen/config.json` (fallback `~/.config/image-gen/config.json`).

## Layout

```
src/
├── cli.ts              # entrypoint CLI (commander)
├── mcp-server.ts       # entrypoint MCP (stdio + http)
├── setup.ts            # wizard prompts
├── doctor.ts           # diagnostica
├── register-mcp.ts     # patcher di ~/.claude.json
├── core/
│   ├── registry.ts     # lista modelli (URL HuggingFace, dim, sha)
│   ├── config.ts       # load/save $XDG_CONFIG_HOME/image-gen/config.json
│   ├── client.ts       # POST /prompt + WS + GET /view
│   ├── generate.ts     # sostituzione placeholder e queue
│   └── installer.ts    # download con HTTP Range resume
└── workflows/          # JSON ComfyUI in formato API (non UI)
```

## Workflow Z-Image (estratto dai blueprint ufficiali ComfyUI 0.22)

Pipeline: `UNETLoader` → `ModelSamplingAuraFlow(shift=3)` → `KSampler(res_multistep,
simple, cfg=1, steps=8)`. Text encoder: `CLIPLoader(type=lumina2)` con `qwen_3_4b.safetensors`.
VAE: `ae.safetensors` (NON l'`sdxl_vae.safetensors`). Negative prompt = `ConditioningZeroOut`
del positive (Z-Image Turbo non usa veri negativi).

## Aggiungere un modello

Una entry in [src/core/registry.ts](src/core/registry.ts), poi `pnpm setup` per scaricarlo.
Schema: `id`, `displayName`, `description`, `destDir`, `filename`, `sizeBytes`, `url`,
`source` (`huggingface` | `civitai`), optional `sha256`, `requiresApiKey`, `recommendedFor`.

## Aggiungere un workflow

Esportare un nuovo JSON in [src/workflows/](src/workflows/) in **formato API ComfyUI**
(non il formato UI con `nodes`/`links`). Riferimento: aprire ComfyUI Web, menù
*Workflow → Save (API format)*. Placeholder supportati: `%PROMPT%`, `%NEGATIVE%`,
`%WIDTH%`, `%HEIGHT%`, `%SEED%`, `%STEPS%`, `%MODEL%`, `%CLIP%`, `%CLIP1%`, `%CLIP2%`, `%VAE%`.
Mappare poi la nuova `WorkflowFamily` in `generate.ts`.

## Comandi rapidi

**Quickstart unico:**
```bash
pnpm configure            # build + wizard + check + register-mcp + install-cli (con conferme)
```

**Step atomici** (prefisso `step:` — l'utente li lancia singolarmente quando serve):
```bash
pnpm step:build           # tsc + copia workflow in dist/
pnpm step:wizard          # setup interattivo: detect + download + write config
pnpm step:check           # verifica salute (doctor)
pnpm step:gen "..."       # CLI generazione
pnpm step:register-mcp    # aggiunge entry in ~/.claude.json (fa backup)
pnpm step:install-cli     # symlink in ~/.local/bin/ (--system per /usr/local/bin)
pnpm step:uninstall-cli   # rimuove i symlink
pnpm step:mcp-serve       # avvia MCP stdio per debug
pnpm step:dev <args>      # `tsx src/cli.ts` per debug arbitrario
```

Funziona uguale con `npm run <name>` o `yarn <name>`. `install-cli` è
**package-manager agnostic** — non usa `pnpm link --global` né `$PNPM_HOME`,
scrive symlink standard XDG.

**Naming:** abbiamo prefissato `step:` perché nomi nudi come `setup`/`doctor`/`init`/
`install`/`start` sono **built-in pnpm** e shadowano gli script utente. `configure`
e `step:*` sono liberi e descrittivi.

> **Attenzione ai nomi:** `setup`, `doctor`, `start`, `install`, `add`, `link`,
> `publish`, `test`, `init`, `run`, `exec`, `dlx` sono **comandi built-in di pnpm**.
> Se chiamati come `pnpm <name>`, pnpm esegue il built-in invece dello script del
> package.json. Per questo gli script qui usano nomi non-conflittuali (`wizard`,
> `check`, `dev`, `link-global`). I subcomandi del CLI restano standard
> (`image-gen setup`, `image-gen doctor`).

## Cosa non fa (volutamente)

- Niente GUI / web UI.
- Niente img2img / inpainting / controlnet (solo text-to-image).
- Niente batch / queue (per N immagini, chiamare N volte).
- Niente integrazione cloud (RunPod, Replicate).
- Niente auto-update modelli.

## Errori frequenti

- **`Value not in list ... not in []` su `LoadBackgroundRemovalModel`**: manca il file
  BiRefNet `.pth` in `models/background_removal/`. Soluzione: `pnpm setup` selezionando
  `birefnet-bg-removal`.
- **`/system_stats` unreachable**: ComfyUI non è in esecuzione, oppure è su un'altra porta.
  Fix: avvia ComfyUI o aggiorna `comfyuiUrl` nel file di config.
- **Tool MCP `generate_image` non visibile in Claude Code**: serve riavviare l'IDE dopo
  `image-gen register-mcp`.
