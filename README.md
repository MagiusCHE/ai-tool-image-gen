# image-gen

Wrapper TypeScript su una istanza locale di **ComfyUI**. Espone una **CLI**
(`image-gen`) e un **MCP server** (`image-gen-mcp`) in modo che qualunque
client AI (Claude Code, Cursor, ecc.) possa generare immagini sulla tua GPU.

- **Stack:** TypeScript, Node 20+, ESM only. Nessun Python in questo repo.
- **Modello di default:** [Z-Image Turbo](https://comfyanonymous.github.io/ComfyUI_examples/z_image/) (Alibaba/Tongyi, 6B). Sub-second 1024×1024 in 8 step. Eccellente rendering del testo — ottimo per icone e loghi.
- **Modelli alternativi:** Flux Schnell, SDXL (DreamShaper Turbo).
- **Trasparenza:** due strategie — `cutout` (BiRefNet, per foto) e `outer-fill` (flood-fill + erosione, per icone/loghi).

## Documentazione

Per casi d'uso pratici vai direttamente alla guida:

| Voglio… | Leggi |
|---|---|
| Installare `image-gen` sulla mia macchina (locale, stessa GPU di ComfyUI) | [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) |
| Configurare un client su un'altra macchina che punta a un `image-gen-mcp` remoto via HTTP/HTTPS | [docs/REMOTE_CLIENT_SETUP.md](docs/REMOTE_CLIENT_SETUP.md) |
| Capire come si comporta un agente AI quando chiama questo tool (trasparenza, scelta del workflow, errori comuni) | [AGENTS.md](AGENTS.md) |
| Storia del design / decisioni implementative | [docs/plans/done/](docs/plans/done/) |

## In due righe

```bash
git clone <repo> && cd image-gen
pnpm install && pnpm configure
# poi riavvia Claude Code per agganciare l'MCP
```

Dettagli, comandi atomici, opzioni CLI/MCP, config XDG: [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).

## Cosa non fa (volutamente)

- GUI / web UI
- img2img / inpainting / controlnet
- Batch / queue
- Cloud GPU (RunPod, Replicate)
- Auto-update dei modelli
