# image-gen — piano implementazione iniziale

Data piano: 2026-05-23
Autore: Claude (Opus 4.7), in collaborazione con l'utente
Stato: bozza, da implementare

## Obiettivo

Creare un tool **self-contained** che permetta a qualsiasi agente AI (Claude Code locale,
agenti remoti via MCP, altri client come Cursor) di generare immagini chiamando una
istanza locale di ComfyUI. L'utente deve poter installare ed essere operativo con:

```bash
git clone <repo> && cd image-gen
pnpm install
pnpm setup            # wizard interattivo: rileva ComfyUI, scarica modelli mancanti
pnpm install-global   # mette image-gen e image-gen-mcp nel PATH
pnpm register-mcp     # registra il server MCP in ~/.claude.json
# da questo momento ogni sessione Claude Code ha il tool generate_image disponibile
```

## Contesto e vincoli

- **Hardware target**: GPU NVIDIA consumer (≥12GB VRAM) o equivalente; Linux/macOS/WSL.
- **ComfyUI**: installato localmente, API attiva su `http://127.0.0.1:8188` (default)
  o porta custom, versione 0.22+ raccomandata.
- **Modelli pre-esistenti**: il setup deve rilevare quali sono già presenti in
  `<comfyuiPath>/models/**/*.safetensors` e non riscaricarli (es. checkpoint SDXL,
  Flux Schnell, encoder CLIP/T5, VAE).
- **Custom nodes ComfyUI** rilevanti se si usa la modalità trasparenza `cutout`:
  pacchetto `background_removal` per BiRefNet.

## Decisioni architetturali (gia prese con l'utente)

1. **Stack: TypeScript puro**. Niente Python. Un solo runtime (Node 20+).
2. **Path progetto**: cartella locale a scelta dell'utente (clone diretto del repo).
3. **Modello default raccomandato**: Z-Image Turbo (Alibaba/Tongyi, novembre 2025).
   - 6B parametri, ~6GB VRAM, <1s a 1024x1024 in 8 step.
   - Eccelle nel rendering testuale → ottimo per icone/loghi.
   - Da scaricare: `z_image_turbo_bf16.safetensors` (~12GB) +
     `qwen_3_4b.safetensors` (~8GB) come text encoder.
4. **Registry modelli**: hardcoded in `src/core/registry.ts`.
5. **Discoverability cross-agent**: via **MCP server** (Model Context Protocol).
   Espone tool `generate_image`, `list_models`, `doctor`.
6. **Doppio trasporto MCP**:
   - **stdio** (default) — agente lancia il server come subprocess, comunicazione
     locale, zero auth.
   - **HTTP/SSE** (`--http --port N --token T`) — daemon per accesso remoto da
     altre macchine.
7. **Distribuzione**: solo locale per ora (no `npm publish`). Eventuale pacchettizzazione
   npm in futuro.
8. **Background removal**: flag `--transparent` aggiunge nodo BiRefNet/RMBG al
   workflow, output PNG con alpha.

## Struttura del progetto

```
image-gen/
├── package.json              # scripts: setup, gen, doctor, register-mcp, mcp-serve,
│                             #          install-global, build
├── tsconfig.json
├── README.md                 # uso CLI + uso MCP + esempi
├── .gitignore                # .image-gen.json, dist/, node_modules/
├── docs/
│   └── plans/
│       └── 01-initial-implementation.md   # questo file
├── src/
│   ├── cli.ts                # entrypoint umano (commander)
│   ├── mcp-server.ts         # entrypoint MCP (stdio + http)
│   ├── setup.ts              # wizard interattivo (prompts)
│   ├── doctor.ts             # diagnostica
│   ├── core/
│   │   ├── client.ts         # API ComfyUI (HTTP /prompt + WS + /view)
│   │   ├── config.ts         # load/save config (project + user)
│   │   ├── generate.ts       # logica generazione: carica workflow → chiama → salva
│   │   ├── installer.ts      # download modelli con progress, resume HTTP range
│   │   └── registry.ts       # lista modelli supportati con URL e metadata
│   └── workflows/
│       ├── zimage_turbo.json
│       ├── flux_schnell.json
│       ├── sdxl_turbo.json
│       └── _transparent_postprocess.json  # snippet bg-removal (BiRefNet)
└── bin/
    ├── image-gen             # shebang node → dist/cli.js
    └── image-gen-mcp         # shebang node → dist/mcp-server.js
```

## Script package.json

```json
{
  "scripts": {
    "build": "tsc",
    "setup": "tsx src/cli.ts setup",
    "doctor": "tsx src/cli.ts doctor",
    "gen": "tsx src/cli.ts generate",
    "register-mcp": "tsx src/cli.ts register-mcp",
    "mcp-serve": "tsx src/mcp-server.ts",
    "install-global": "pnpm build && pnpm link --global",
    "start": "tsx src/cli.ts"
  }
}
```

## Dipendenze

- **runtime**:
  - `commander` — CLI parsing
  - `prompts` — wizard interattivo
  - `chalk` — output colorato
  - `ora` — spinner
  - `cli-progress` — progress bar per download
  - `ws` — websocket client ComfyUI
  - `undici` — HTTP client (stream + range requests)
  - `@modelcontextprotocol/sdk` — MCP server SDK ufficiale
  - `zod` — validazione input MCP
- **dev**:
  - `typescript`, `tsx`, `@types/node`, `@types/prompts`, `@types/ws`

## Registry modelli (`src/core/registry.ts`)

Lista di partenza:

| id | nome display | dest dir | size | url | gia presente? |
|---|---|---|---|---|---|
| `zimage-turbo` | Z-Image Turbo (bf16) | `diffusion_models/` | ~12GB | https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/z_image_turbo_bf16.safetensors | no |
| `qwen3-4b-encoder` | Qwen3-4B text encoder | `text_encoders/` | ~8GB | https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/qwen_3_4b.safetensors | no |
| `flux-schnell-fp8` | Flux Schnell fp8 | `unet/` | 17GB | (gia presente) | si |
| `dreamshaper-xl-turbo` | DreamShaper XL Turbo | `checkpoints/` | 6.5GB | (gia presente) | si |
| `flux-icon-maker-lora` | Flux Icon Maker LoRA | `loras/` | ~200MB | https://civitai.com/api/download/models/... (richiede API key) | no |
| `birefnet-bg-removal` | BiRefNet (alpha matting) | `background_removal/` | 1GB | https://huggingface.co/ZhengPeng7/BiRefNet/resolve/main/BiRefNet-portrait-epoch_150.pth | no |

Schema entry registry:

```ts
type ModelEntry = {
  id: string;
  displayName: string;
  description: string;
  destDir: 'diffusion_models' | 'text_encoders' | 'unet' | 'checkpoints' | 'loras' | 'vae' | 'clip' | 'background_removal';
  filename: string;
  sizeBytes: number;        // approx, per progress bar
  url: string;
  sha256?: string;          // opzionale, verifica integrita
  source: 'huggingface' | 'civitai';
  requiresApiKey?: boolean; // civitai per alcuni modelli NSFW
  recommendedFor?: string[]; // es. ['icons', 'logos']
};
```

## Workflow JSON

Formato **API** di ComfyUI (NON il formato UI). Esempio struttura per `zimage_turbo.json`:

```json
{
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "%MODEL%" } },
  "2": { "class_type": "CLIPTextEncode", "inputs": { "text": "%PROMPT%", "clip": ["1", 1] } },
  "3": { "class_type": "CLIPTextEncode", "inputs": { "text": "%NEGATIVE%", "clip": ["1", 1] } },
  "4": { "class_type": "EmptyLatentImage", "inputs": { "width": "%WIDTH%", "height": "%HEIGHT%", "batch_size": 1 } },
  "5": { "class_type": "KSampler", "inputs": { "seed": "%SEED%", "steps": "%STEPS%", "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0] } },
  "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
  "7": { "class_type": "SaveImage", "inputs": { "filename_prefix": "image-gen", "images": ["6", 0] } }
}
```

I placeholder `%PROMPT%`, `%NEGATIVE%`, `%SEED%`, `%WIDTH%`, `%HEIGHT%`, `%STEPS%`, `%MODEL%`
vengono sostituiti runtime da `generate.ts`. (Per Z-Image i nodi reali sono diversi —
usare `UNETLoader` + `DualCLIPLoader` con qwen_3_4b. Verificare con il workflow
ufficiale linkato: https://comfyanonymous.github.io/ComfyUI_examples/z_image/)

Per `--transparent`, dopo VAEDecode si inserisce un nodo `BiRefNet` (o
`Image Remove Background (BRIA)` da `comfyui-utils-nodes`) che produce
un'immagine RGBA, poi SaveImage.

## Comportamento `pnpm setup`

1. Stampa banner.
2. **Detect ComfyUI path**: prova path tipici (`~/ComfyUI`, `~/comfyui`, `/opt/ComfyUI`,
   eventualmente sotto `~/Sources/`). Se trovato chiede conferma, altrimenti prompt path.
3. **Detect ComfyUI URL**: prova `http://127.0.0.1:8188`, poi `:8189`, poi `:7860`.
   Verifica con `GET /system_stats`. Se nessuno risponde, chiede l'URL.
4. **Scan modelli presenti**: legge `<comfyuiPath>/models/*/*.safetensors` etc.
5. **Checklist modelli da scaricare**: prompts multi-select con default su
   `zimage-turbo`, `qwen3-4b-encoder`, `birefnet-bg-removal`. I gia presenti sono
   pre-spuntati e disabilitati.
6. **Download**: per ogni modello selezionato, scarica in
   `<comfyuiPath>/models/<destDir>/<filename>` con progress bar, supporta resume
   con HTTP Range se interrotto.
7. **Copia workflow** in `<comfyuiPath>/user/default/workflows/image-gen-*.json`
   (opzionale, cosi sono visibili nella UI Web di ComfyUI).
8. Salva config in `./.image-gen.json` e (mirror) `~/.config/image-gen/config.json`.
9. Stampa next steps: `pnpm install-global` e `pnpm register-mcp`.

## Comportamento `pnpm doctor`

Verifica:
- `.image-gen.json` presente
- ComfyUI raggiungibile a `comfyuiUrl`
- modelli configurati esistono su disco
- nodi custom richiesti presenti (es. `background_removal/` se usi `--transparent`)
- `qwen_3_4b.safetensors` presente se default e Z-Image
- spazio libero su disco

Output: tabella colorata `[✓]`/`[✗]`/`[!]` con suggerimenti per ogni problema.

## Comportamento `image-gen generate`

```
image-gen generate "<prompt>" [options]

Options:
  -o, --output <path>          file PNG di output (default: ./generated-<timestamp>.png)
  -m, --model <id>             zimage|flux|sdxl (default: zimage se installato, altrimenti sdxl)
  -s, --size <wxh>             es. 1024x1024 (default: 1024x1024)
  -n, --negative <text>        prompt negativo
  --steps <n>                  override steps
  --seed <n>                   seed (default: random)
  --transparent                aggiunge bg-removal, output RGBA
  --lora <id>                  applica un LoRA dal registry
  --quiet                      no progress
  --json                       output JSON (per uso programmatico)
```

## MCP server (`src/mcp-server.ts`)

Usa `@modelcontextprotocol/sdk`. Tool esposti:

### `generate_image`
```ts
input: {
  prompt: string,
  output_path: string,
  model?: 'zimage' | 'flux' | 'sdxl',
  width?: number,    // default 1024
  height?: number,   // default 1024
  steps?: number,
  seed?: number,
  negative?: string,
  transparent?: boolean,
}
output: { success: true, path: string, seed: number, durationMs: number }
       | { success: false, error: string }
```

### `list_models`
Ritorna lista dei modelli configurati (presenti + supportati).

### `doctor`
Esegue lo stesso check di `pnpm doctor` e ritorna JSON.

**Trasporto stdio** (default):
```bash
image-gen-mcp
```

**Trasporto HTTP** (remoto, daemon):
```bash
image-gen-mcp --http --port 9090 --token <bearer>
```

Stesso server, stesso codice, cambia solo l'adapter di trasporto (~50 righe).

## Comportamento `pnpm register-mcp`

Modifica `~/.claude.json`, aggiungendo:

```json
{
  "mcpServers": {
    "image-gen": {
      "command": "image-gen-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

**Importante**: backup di `~/.claude.json` in `~/.claude.json.bak-<timestamp>` prima
di modificare. Se la chiave `mcpServers.image-gen` esiste gia, chiedere prima di
sovrascrivere.

Opzionale (flag `--remote <url>`): registra una entry HTTP invece di stdio.

## Test end-to-end (task #13)

1. `pnpm install`
2. `pnpm setup` accettando autodetect, **selezionando solo BiRefNet** per ridurre il
   download (Z-Image si puo aggiungere dopo, per primo smoke test basta usare
   DreamShaper Turbo che e gia presente).
3. `pnpm doctor` → tutto verde.
4. `pnpm gen "a geometric blue fox logo, flat illustration, white background"
   -m sdxl -o /tmp/test.png` → verifica che `/tmp/test.png` sia un PNG valido
   (`file /tmp/test.png` → "PNG image data, 1024 x 1024").
5. `pnpm gen "..." --transparent -o /tmp/test-alpha.png` → verifica alpha channel
   (`identify -format "%[channels]" /tmp/test-alpha.png` → `rgba`).
6. `pnpm install-global && pnpm register-mcp`.
7. (Manuale) avvia nuova sessione Claude Code, verifica che il tool `generate_image`
   appaia nella lista MCP.

## Ordine di esecuzione consigliato

Fondazioni → logica → UX → distribuzione:

1. Task #1  — scaffold (package.json, tsconfig, dirs)
2. Task #2  — registry modelli
3. Task #3  — config loader
4. Task #4  — client API ComfyUI
5. Task #5  — workflows JSON
6. Task #6  — generate.ts
7. Task #7  — installer
8. Task #8  — wizard setup
9. Task #9  — doctor
10. Task #10 — CLI cli.ts
11. Task #11 — MCP server stdio+http
12. Task #12 — register-mcp
13. Task #13 — test end-to-end
14. Task #14 — README

## Note implementative importanti

- **Workflow Z-Image**: verificare i nomi esatti dei nodi sul workflow ufficiale
  (https://comfyanonymous.github.io/ComfyUI_examples/z_image/) prima di
  hardcodare il JSON. La struttura sopra e indicativa.
- **API ComfyUI**: il client_id va generato (UUID v4) e passato sia in
  `POST /prompt` (body) sia in `GET /ws?clientId=...` (websocket). I messaggi
  WS rilevanti sono `executing` (con `node: null` indica fine), `progress`, e
  `executed` (contiene `output.images[]` con `filename`, `subfolder`, `type`).
  L'immagine si scarica via `GET /view?filename=X&subfolder=Y&type=output`.
- **Civitai**: per LoRA che richiedono auth, supportare env var
  `CIVITAI_API_KEY` (Bearer in header Authorization).
- **HuggingFace**: download diretti via `resolve/main/<file>` — niente auth per
  modelli pubblici.
- **Resume download**: salvare prima in `<filename>.part`, fare HEAD per
  ottenere `Content-Length`, GET con `Range: bytes=<size>-` se file parziale
  esiste, rinominare in `<filename>` solo a download completo.
- **MCP HTTP transport**: usare `StreamableHTTPServerTransport` dal SDK
  (non SSE legacy). Auth via header `Authorization: Bearer <token>`.

## Cose esplicitamente NON incluse (per evitare over-engineering)

- Nessuna GUI web
- Nessun database immagini generate
- Nessuna queue / batch nativo (per N immagini, chiamare N volte)
- Nessun auto-update modelli
- Nessuna gestione multi-istanza ComfyUI
- Nessun supporto per pipeline complesse (img2img, inpainting, controlnet) — solo
  text-to-image. Aggiungibile in futuro se serve.
- Nessuna integrazione con cloud GPU (RunPod, Replicate, ecc.)

## Aperto / da decidere durante implementazione

- Nome esatto del comando: `image-gen` o `cg`? Lascio `image-gen` perche piu
  esplicito.
- Versione MCP SDK: usare l'ultima stabile di `@modelcontextprotocol/sdk` al
  momento dell'implementazione.
- Se i nodi BiRefNet non sono presenti come custom_node, fallback su
  `comfyui-utils-nodes` o segnalare il problema in `doctor`.
