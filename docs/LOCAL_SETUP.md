# image-gen — installazione e uso locale

Setup end-to-end di `image-gen` come **server MCP locale** e/o **CLI shell**
sulla stessa macchina dove gira ComfyUI. Per usare un'istanza remota da un
altro host, vedi [REMOTE_CLIENT_SETUP.md](REMOTE_CLIENT_SETUP.md).

## Prerequisiti

- **Node 20+** (`node --version`).
- **pnpm** consigliato (npm e yarn funzionano uguale, basta sostituire il verbo).
- **ComfyUI** in esecuzione localmente o raggiungibile via HTTP. Il wizard
  chiede `comfyuiPath` (per scrivere i modelli scaricati) e `comfyuiUrl` (per
  parlarci). Pre-popolabili via `$COMFYUI_PATH` e `$COMFYUI_URL`.

## Quickstart (un comando)

```bash
git clone <repo> && cd image-gen
pnpm install        # o `npm install`
pnpm configure      # build + wizard + check + register-mcp + install-cli, con conferme
```

A fine `configure`, **riavvia Claude Code** per agganciare l'MCP server.
Da quel momento `generate_image`, `list_models`, `doctor` sono disponibili in
qualunque sessione.

## Step atomici

`configure` orchestrа script single-purpose. Eseguili a mano quando serve (es.
ri-scaricare un modello, ri-registrare l'MCP dopo aver toccato `~/.claude.json`,
ecc.). Sono tutti prefissati `step:`:

```bash
pnpm step:build           # tsc + copia workflow in dist/
pnpm step:wizard          # setup interattivo: detect ComfyUI, download modelli, scrive config
pnpm step:check           # health check (alias di doctor)
pnpm step:gen "..."       # CLI: genera un'immagine
pnpm step:register-mcp    # aggiunge la entry image-gen in ~/.claude.json (con backup)
pnpm step:install-cli     # symlink image-gen / image-gen-mcp in ~/.local/bin
pnpm step:uninstall-cli   # rimuove i symlink
pnpm step:mcp-serve       # avvia l'MCP stdio (per debug)
pnpm step:dev <args>      # `tsx src/cli.ts <args>` per debug CLI ad-hoc
```

### Installare / rimuovere il comando shell

```bash
pnpm step:install-cli                  # per-user: symlink → ~/.local/bin/
sudo pnpm step:install-cli --system    # system-wide: symlink → /usr/local/bin/
pnpm step:uninstall-cli                # rimuove i symlink per-user
sudo pnpm step:uninstall-cli --system  # rimuove i symlink system-wide
```

> Con `npm` serve `npm run step:install-cli -- --system` (npm richiede `--` per
> inoltrare i flag agli script). pnpm li inoltra direttamente, senza `--`.

Override della directory di destinazione: `$IMAGE_GEN_BIN_DIR`.

> **Multi-utente:** i symlink (per-user o system) coprono solo la **CLI**. Per
> ogni utente che vuole usare il tool servono comunque `pnpm step:wizard` (per
> scrivere la sua `$XDG_CONFIG_HOME/image-gen/config.json`) e
> `pnpm step:register-mcp` (per la sua `~/.claude.json`).

> **Package manager:** funziona uguale con `npm`, `pnpm`, `yarn`. Sostituisci il
> verbo (`npm run configure`, `yarn configure`, …).
>
> **Naming degli script:** `setup`, `doctor`, `start`, `install`, `init` sono
> built-in di pnpm e shadowano gli script. Per questo l'orchestrator è
> `configure` e gli step atomici sono prefissati `step:`. Tutti gli script
> restano invocabili come `pnpm run <name>` per essere espliciti.

## CLI

```bash
image-gen generate "<prompt>" [options]
  -o, --output <path>            output PNG (default: ./generated-<timestamp>.png)
  -m, --model <id>               zimage | flux | sdxl  (default: dalla config)
  -s, --size <WxH>               es. 1024x1024 (default 1024x1024)
  -n, --negative <text>          negative prompt (solo sdxl)
      --steps <n>                override sampling steps
      --seed <n>                 seed fisso (default: random)
      --transparent              shorthand di --transparent-mode=cutout
      --transparent-mode <mode>  cutout | outer-fill
      --outer-fill-erode <n>     pixel di erosione post outer-fill (default 2; 0 disattiva)
      --quiet                    no progress
      --json                     output machine-readable

image-gen setup           # ri-esegue il wizard      (pnpm step:wizard)
image-gen doctor [--json] # health check             (pnpm step:check)
image-gen list-models     # mostra modelli installati/disponibili
image-gen register-mcp    # aggiunge entry a ~/.claude.json (con backup)
```

I **nomi dei sotto-comandi CLI restano standard** (`setup`, `doctor`, …); il
rename a `step:*` è solo per gli alias `pnpm`.

### Esempi

```bash
# icona veloce
image-gen gen "a geometric blue fox logo, flat illustration, white background" \
  -m sdxl --steps 8 -o /tmp/fox.png

# icona trasparente (outer-fill, ideale per icone outlined)
image-gen gen "an orange cartoon mushroom, side view, isolated on pure white background" \
  -m zimage --transparent-mode outer-fill -o /tmp/mushroom-rgba.png

# cutout fotografico (BiRefNet)
image-gen gen "studio photo of a red sneaker on neutral backdrop" \
  -m sdxl --transparent-mode cutout -o /tmp/sneaker-cutout.png

# seed fisso per riproducibilità
image-gen gen "..." --seed 42
```

Per la scelta tra `cutout` e `outer-fill` vedi [AGENTS.md](../AGENTS.md#trasparenza-quale-modalità).

## MCP server

L'MCP server espone tre tool a qualunque client compatibile:

| Tool | Descrizione |
|---|---|
| `generate_image` | Genera un PNG. Required: `prompt`. Optional: `output_path`, `model`, `width`, `height`, `steps`, `seed`, `negative`, `transparent`, `outer_fill_erode`. |
| `list_models` | Lista la registry + stato installato. |
| `doctor` | Ritorna JSON di health-check. |

**Transport stdio** (default, usato da Claude Code in locale):

```bash
image-gen-mcp
```

`pnpm step:register-mcp` scrive l'entry in `~/.claude.json` puntando al path
assoluto del binario, quindi Claude lo lancia indipendentemente dal cwd.

**Transport HTTP** (daemon per accesso remoto):

```bash
image-gen-mcp --http --port 9090 --token <bearer>
```

Espone `POST /mcp` (Streamable HTTP, MCP spec 2025-06-18) e onora
`Authorization: Bearer <token>` se passato. Per configurare un client che si
connette a questo daemon vedi [REMOTE_CLIENT_SETUP.md](REMOTE_CLIENT_SETUP.md).

## Config

`pnpm step:wizard` scrive un singolo file:

```
$XDG_CONFIG_HOME/image-gen/config.json
```

(fallback `~/.config/image-gen/config.json` se `$XDG_CONFIG_HOME` non è settato).

Contiene `comfyuiPath`, `comfyuiUrl`, modello di default, e la lista dei modelli
installati. CLI e MCP server leggono dallo stesso path, indipendentemente dal cwd.
Puoi pre-popolare il wizard con `$COMFYUI_PATH` e `$COMFYUI_URL`.

## Modelli supportati (registry)

`image-gen list-models` stampa la registry corrente. Aggiungere un modello è
una entry in [src/core/registry.ts](../src/core/registry.ts) — vedi
[AGENTS.md](../AGENTS.md#aggiungere-un-modello) per lo schema.

Z-Image Turbo (default) richiede tre file:

- `models/diffusion_models/z_image_turbo_bf16.safetensors`
- `models/text_encoders/qwen_3_4b.safetensors` (CLIPLoader type: `lumina2`)
- `models/vae/ae.safetensors`

Il wizard li scarica con resume-on-failure (HTTP Range).

## Layout del progetto

```
image-gen/
├── src/
│   ├── cli.ts                 # entrypoint commander
│   ├── mcp-server.ts          # entrypoint MCP (stdio + http)
│   ├── setup.ts               # wizard interattivo
│   ├── doctor.ts              # diagnostica
│   ├── register-mcp.ts        # patcher di ~/.claude.json
│   ├── core/
│   │   ├── client.ts          # client HTTP + WS verso ComfyUI
│   │   ├── config.ts          # load/save config
│   │   ├── generate.ts        # workflow substitution + queue + save
│   │   ├── installer.ts       # downloader con resume
│   │   └── registry.ts        # lista modelli
│   └── workflows/             # JSON ComfyUI in formato API
├── bin/                       # image-gen, image-gen-mcp shebangs
├── docs/                      # guide d'uso (questo file, REMOTE_CLIENT_SETUP, …)
│   └── plans/                 # design docs storici
├── AGENTS.md                  # istruzioni operative per agenti AI (auto-caricato in Claude Code)
└── CLAUDE.md                  # @AGENTS.md
```
