#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadConfig } from './core/config.js';
import { generate, type WorkflowFamily, type TransparentMode } from './core/generate.js';
import { MODEL_REGISTRY } from './core/registry.js';
import { runDoctor } from './doctor.js';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'image-gen', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'generate_image',
    {
      title: 'Generate image (ComfyUI)',
      description: 'Generate a PNG image with a local ComfyUI instance and save it to disk. If `output_path` is omitted, the file is written as `generated-<timestamp>.png` in the current working directory. The tool response contains: (1) a text block with a clickable `file://...` link to the saved image, (2) the PNG inline (so the agent can see it), (3) `structuredContent` with `path`, `fileUrl`, `seed`. When linking the result back to the user, always use the `fileUrl` from `structuredContent` (the `file://...` URL) so the link opens reliably regardless of the user editor cwd. Never construct a bare relative link to the basename.',
      inputSchema: {
        prompt: z.string().describe('The text prompt'),
        output_path: z.string().optional().describe('Filesystem path for the PNG. Absolute, or relative to the MCP process cwd. If omitted, defaults to `./generated-<timestamp>.png` in cwd. Suggest a project-appropriate location (e.g. `files/images/<name>.png` or `assets/<name>.png`) when generating for a specific app.'),
        model: z.enum(['zimage', 'flux', 'sdxl']).optional().describe('Model family (default: zimage if installed, else sdxl)'),
        width: z.number().int().positive().optional().describe('Width in px (default 1024)'),
        height: z.number().int().positive().optional().describe('Height in px (default 1024)'),
        steps: z.number().int().positive().optional().describe('Sampling steps (default depends on model)'),
        seed: z.number().int().optional().describe('Fixed seed (default: random)'),
        negative: z.string().optional().describe('Negative prompt (only honoured by sdxl family)'),
        transparent: z.union([
          z.boolean(),
          z.enum(['cutout', 'outer-fill']),
        ]).optional().describe(
          'Transparency strategy. `"cutout"` (or `true`) removes the background via BiRefNet — best for photos/product shots where you want to isolate a subject. `"outer-fill"` generates opaque, then makes only the near-white exterior transparent via flood-fill from the corners, followed by a small alpha-mask erosion (see `outer_fill_erode`) that eats the residual anti-aliased halo between any dark outline and the transparent exterior — best for app icons, logos, and any flat artwork sitting on a solid white outer background where the subject has its own fill colour (interior whites are preserved). Omit / `false` = no transparency. For icons or logos with a coloured shape, prefer `"outer-fill"` and instruct the prompt to place the subject "on a pure white background".',
        ),
        outer_fill_erode: z.number().int().min(0).max(8).optional().describe('Only used by `transparent: "outer-fill"`. After the flood-fill, shrink the opaque silhouette by this many pixels (4-connected binary erosion) to remove the grey anti-aliased halo that the flood-fill leaves around dark outlines. Default 2. Set to 0 to disable. Icons without a dark outline usually only need 0–1; outlined icons (black/dark borders on a white background) need 2.'),
      },
    },
    async (args) => {
      const cfg = await loadConfig();
      if (!cfg) {
        return { isError: true, content: [{ type: 'text', text: 'image-gen not configured. Run `image-gen setup` first.' }] };
      }
      try {
        const outputPath = args.output_path && args.output_path.trim().length > 0
          ? path.resolve(args.output_path)
          : path.resolve(process.cwd(), `generated-${Date.now()}.png`);
        const result = await generate(cfg, {
          prompt: args.prompt,
          outputPath,
          model: args.model as WorkflowFamily | undefined,
          width: args.width,
          height: args.height,
          steps: args.steps,
          seed: args.seed,
          negative: args.negative,
          transparent: args.transparent as TransparentMode | boolean | undefined,
          outerFillErode: args.outer_fill_erode,
        });
        const absPath = path.resolve(result.path);
        const fileUrl = 'file://' + absPath;
        const relPath = path.relative(process.cwd(), absPath) || absPath;
        const fileName = path.basename(absPath);

        const summary = [
          `Image saved.`,
          ``,
          `- file: [${fileName}](${fileUrl})`,
          `- absolute: \`${absPath}\``,
          `- relative to MCP cwd: \`${relPath}\``,
          `- model: ${result.family}  ·  seed: ${result.seed}  ·  ${(result.durationMs / 1000).toFixed(1)}s`,
        ].join('\n');

        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          { type: 'text', text: summary },
        ];

        try {
          const bytes = await fs.readFile(absPath);
          content.push({
            type: 'image',
            data: bytes.toString('base64'),
            mimeType: 'image/png',
          });
        } catch {
          // If we can't read it back for any reason, still return the text summary.
        }

        return {
          content,
          structuredContent: {
            success: true,
            path: absPath,
            fileUrl,
            seed: result.seed,
            durationMs: result.durationMs,
            family: result.family,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `generate failed: ${(err as Error).message}` }],
        };
      }
    },
  );

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description: 'List supported model entries and which ones are installed locally.',
      inputSchema: {},
    },
    async () => {
      const cfg = await loadConfig();
      const installed = new Set(cfg?.installedModelIds ?? []);
      const items = MODEL_REGISTRY.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        family: m.destDir,
        sizeGb: Number((m.sizeBytes / 1e9).toFixed(2)),
        installed: installed.has(m.id),
        recommendedFor: m.recommendedFor ?? [],
      }));
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    },
  );

  server.registerTool(
    'doctor',
    {
      title: 'Diagnose image-gen setup',
      description: 'Run health checks and return a structured report.',
      inputSchema: {},
    },
    async () => {
      const results = await runDoctor();
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    },
  );

  return server;
}

interface RunOptions {
  http?: boolean;
  port?: number;
  token?: string;
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--http') opts.http = true;
    else if (a === '--port') opts.port = parseInt(argv[++i] ?? '0', 10);
    else if (a === '--token') opts.token = argv[++i];
  }
  return opts;
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function runHttp(port: number, token: string | undefined): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    if (token) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    try {
      let body: unknown;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString('utf-8');
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  httpServer.listen(port, '0.0.0.0', () => {
    console.error(`image-gen MCP HTTP server listening on http://0.0.0.0:${port}/mcp${token ? ' (token-protected)' : ''}`);
  });
}

const opts = parseArgs(process.argv.slice(2));
if (opts.http) {
  if (!opts.port) {
    console.error('--http requires --port <n>');
    process.exit(1);
  }
  runHttp(opts.port, opts.token).catch((err) => {
    console.error(`MCP HTTP server failed: ${(err as Error).message}`);
    process.exit(1);
  });
} else {
  runStdio().catch((err) => {
    console.error(`MCP stdio server failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
