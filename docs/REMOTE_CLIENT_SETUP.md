# image-gen — configurare un client remoto (HTTP/HTTPS)

Istruzioni operative per un agente AI (o un umano) che deve **configurare una
macchina-client** in modo che Claude Code (o qualunque altro MCP client) chiami
un'istanza `image-gen-mcp` **in esecuzione su un altro host** via HTTP.

Questo file vive nel repo del *server*. Va consegnato (copia/incolla, o
passato come prompt) all'agente sulla macchina-client. Non serve clonare nulla
sul client: l'MCP server gira remoto, qui registriamo solo l'endpoint.

---

## Prerequisiti che l'agente deve verificare prima di iniziare

1. **Sul lato server (l'altra macchina, non questa)** l'utente deve aver già
   avviato il server in modalità HTTP:
   ```bash
   image-gen-mcp --http --port <PORT> --token <BEARER>
   ```
   Se non l'ha fatto, fermati e chiedi all'utente di farlo prima di procedere.

2. **L'agente deve sapere**:
   - `<SERVER_URL>` — URL completo dell'endpoint MCP, es. `https://gpu.example.org:9090/mcp`
     oppure `http://192.168.1.42:9090/mcp` su LAN/Tailscale.
   - `<BEARER>` — il token configurato lato server con `--token`. Senza questo le
     richieste vengono respinte con 401.
   - `<NAME>` — nome con cui registrare il server in `.claude.json`. Default
     consigliato: `image-gen`. Cambiarlo solo se è già occupato da un'altra
     entry locale.

   Se uno qualunque di questi è ignoto, **chiedere all'utente prima di scrivere
   nulla**. Non inventarli.

3. **Connettività**: l'host del client deve poter raggiungere `<SERVER_URL>`.
   Verificare con un `curl -sSf -H "Authorization: Bearer <BEARER>" <SERVER_URL>`:
   un 405/400 va bene (significa che TCP/TLS funzionano, il server risponde).
   Un timeout o connection refused = problema di rete/firewall, **non**
   risolvibile editando il client; segnalare e fermarsi.

---

## Passo unico: aggiungere l'entry MCP a `~/.claude.json`

`~/.claude.json` è un JSON globale di Claude Code. Le entry MCP possono stare:
- a livello globale (`cfg.mcpServers`) — disponibili in ogni progetto;
- per-progetto (`cfg.projects["/path/to/proj"].mcpServers`) — solo in quel cwd.

Per un MCP remoto generico, la registrazione **globale** è quasi sempre quella
giusta. Lo schema della entry per un server HTTP è:

```json
{
  "type": "http",
  "url": "<SERVER_URL>",
  "headers": { "Authorization": "Bearer <BEARER>" }
}
```

> Nota: lo schema MCP supporta anche `"type": "sse"` per server che fanno
> Server-Sent Events. `image-gen-mcp --http` usa
> `StreamableHTTPServerTransport`, quindi va con `"type": "http"`.

### Script Node.js idempotente per applicare la patch

L'agente può eseguire questo snippet sostituendo i placeholder. È idempotente:
se l'entry esiste già con gli stessi valori, non fa niente; se esiste con valori
diversi, la **aggiorna** dopo conferma esplicita dell'utente.

```bash
node -e '
const fs = require("node:fs");
const path = require("node:os").homedir() + "/.claude.json";

const NAME    = "image-gen";                          // ← <NAME>
const URL     = "https://gpu.example.org:9090/mcp";   // ← <SERVER_URL>
const BEARER  = "REPLACE_ME";                         // ← <BEARER>

if (BEARER === "REPLACE_ME") {
  console.error("Refusing to run with placeholder BEARER. Edit the script first.");
  process.exit(1);
}

// 1) backup timestamped
const backup = path + ".bak." + Date.now();
fs.copyFileSync(path, backup);
console.error("backup:", backup);

// 2) load + patch
const cfg = JSON.parse(fs.readFileSync(path, "utf-8"));
cfg.mcpServers ||= {};

const newEntry = {
  type: "http",
  url: URL,
  headers: { Authorization: "Bearer " + BEARER },
};

const existing = cfg.mcpServers[NAME];
if (existing && JSON.stringify(existing) === JSON.stringify(newEntry)) {
  console.error("entry already up to date, nothing to do");
  fs.unlinkSync(backup);   // no-op patch, drop the backup
  process.exit(0);
}
if (existing) {
  console.error("WARNING: an entry named", NAME, "already exists with different values:");
  console.error(JSON.stringify(existing, null, 2));
  console.error("It will be overwritten. Ctrl-C now to abort, or re-run with a different NAME.");
}

cfg.mcpServers[NAME] = newEntry;
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.error("OK — wrote MCP entry", NAME, "→", URL);
'
```

### Variante per registrazione *per-progetto*

Se l'utente vuole il server visibile solo da un cwd specifico (es. un repo che
lavora su immagini), sostituire la patch con:

```js
const PROJ = "/absolute/path/to/project";
cfg.projects ||= {};
cfg.projects[PROJ] ||= {};
cfg.projects[PROJ].mcpServers ||= {};
cfg.projects[PROJ].mcpServers[NAME] = newEntry;
```

---

## Verifica post-installazione

1. **Riavviare Claude Code / l'IDE.** L'MCP viene caricato all'avvio del client;
   senza riavvio l'entry nuova non viene letta.
2. Dentro Claude, chiedere: *"quali tool MCP `generate_image` sono disponibili?"*
   Se l'entry funziona, l'agente vedrà `mcp__image-gen__generate_image`,
   `mcp__image-gen__list_models`, `mcp__image-gen__doctor`.
3. Eseguire una generazione di prova con un prompt minimale:
   ```
   Genera un'icona 256×256 con il tool generate_image.
   ```
   Se torna un PNG inline, la pipeline end-to-end funziona.

---

## Differenze rilevanti rispetto a un MCP locale

- **`output_path` è sul filesystem del *server*, non del client.** Il PNG arriva
  comunque al client *inline* nella response (base64), quindi Claude lo "vede"
  e può visualizzarlo. Ma il file su disco rimane sulla macchina remota. Se
  serve anche il file fisico lato client, l'utente deve montare uno share di
  rete o trasferirlo manualmente.
- **Nessun `pnpm setup` lato client.** Il client non scarica modelli, non parla
  con ComfyUI, non ha bisogno di config XDG: tutto vive sul server.
- **Latenza.** Una generazione include il round-trip HTTP del PNG (può essere
  qualche MB). Su LAN trascurabile; su WAN aggiunge facilmente 1-3 secondi.

---

## Troubleshooting rapido

| Sintomo | Causa probabile | Fix |
|---|---|---|
| `connection refused` | server non in esecuzione o porta sbagliata | sull'host server: rilanciare `image-gen-mcp --http --port <PORT> --token <BEARER>` |
| `401 unauthorized` | bearer mancante o errato | verificare che `<BEARER>` nel client corrisponda esattamente a quello passato a `--token` lato server |
| Claude non vede il tool dopo restart | entry scritta nel posto sbagliato (per-progetto vs globale) o JSON corrotto | controllare `~/.claude.json`, ripristinare dal `.bak.<timestamp>` |
| TLS error / self-signed cert | server HTTPS con cert non valido | usare HTTP dietro VPN/Tailscale, o configurare un cert valido (Caddy/Let's Encrypt davanti al server) |
| Generazione fallisce con `comfy-gen not configured` o simili | il server remoto non ha config XDG / non vede ComfyUI | sul server, non sul client: `image-gen doctor` per diagnosticare |
