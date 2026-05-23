import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { request } from 'undici';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import type { ModelEntry } from './registry.js';

export interface InstallOptions {
  /** Absolute path to ComfyUI installation (with /models/ subtree). */
  comfyuiPath: string;
  /** Civitai API key, optional. Env CIVITAI_API_KEY takes precedence. */
  civitaiApiKey?: string;
  /** Disable progress bar (e.g. CI). */
  quiet?: boolean;
}

export interface InstallResult {
  model: ModelEntry;
  destPath: string;
  /** true if no download happened (already present, missing API key, …) */
  skipped: boolean;
  /** true if the download attempt failed. Mutually exclusive with skipped=already-present. */
  failed: boolean;
  reason?: string;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function fileSize(p: string): Promise<number> {
  try { return (await fs.stat(p)).size; } catch { return 0; }
}

function authHeaders(model: ModelEntry, opts: InstallOptions): Record<string, string> {
  if (model.source === 'civitai') {
    const key = process.env.CIVITAI_API_KEY ?? opts.civitaiApiKey;
    if (key) return { authorization: `Bearer ${key}` };
  }
  return {};
}

/**
 * Download one model with HTTP Range resume:
 *   - download to `<filename>.part`
 *   - if `.part` already exists, send Range: bytes=<size>- to resume
 *   - on completion, rename to final filename
 */
export async function installModel(model: ModelEntry, opts: InstallOptions): Promise<InstallResult> {
  if (model.source === 'local' || !model.url) {
    return { model, destPath: '', skipped: true, failed: false, reason: 'no URL (manual install)' };
  }

  const destDir = path.join(opts.comfyuiPath, 'models', model.destDir);
  await fs.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, model.filename);
  const partPath = destPath + '.part';

  if (await fileExists(destPath)) {
    return { model, destPath, skipped: true, failed: false, reason: 'already present' };
  }

  if (model.requiresApiKey && !process.env.CIVITAI_API_KEY && !opts.civitaiApiKey) {
    return { model, destPath, skipped: true, failed: true, reason: 'requires CIVITAI_API_KEY (not set)' };
  }

  const existingBytes = await fileSize(partPath);
  const headers: Record<string, string> = { ...authHeaders(model, opts) };
  if (existingBytes > 0) headers.range = `bytes=${existingBytes}-`;

  const resp = await request(model.url, { method: 'GET', headers, maxRedirections: 5 });
  if (resp.statusCode === 416) {
    await fs.rename(partPath, destPath);
    return { model, destPath, skipped: true, failed: false, reason: 'already fully downloaded' };
  }
  if (resp.statusCode >= 400) {
    const body = await resp.body.text();
    throw new Error(`Download failed for ${model.id}: HTTP ${resp.statusCode} — ${body.slice(0, 200)}`);
  }

  const contentLengthHeader = resp.headers['content-length'];
  const remainingBytes = contentLengthHeader ? Number(contentLengthHeader) : 0;
  const totalBytes = existingBytes + remainingBytes || model.sizeBytes;
  const isResume = existingBytes > 0 && resp.statusCode === 206;

  let bar: cliProgress.SingleBar | null = null;
  if (!opts.quiet) {
    bar = new cliProgress.SingleBar({
      format: `  ${chalk.cyan(model.id.padEnd(28))} [{bar}] {percentage}% | {value_mb}/{total_mb} MB | {speed_mb}/s`,
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true,
    });
    bar.start(totalBytes, isResume ? existingBytes : 0, {
      value_mb: ((isResume ? existingBytes : 0) / 1_000_000).toFixed(1),
      total_mb: (totalBytes / 1_000_000).toFixed(1),
      speed_mb: '0.0',
    });
  }

  let bytesDone = isResume ? existingBytes : 0;
  const startedAt = Date.now();
  const out = createWriteStream(partPath, { flags: isResume ? 'a' : 'w' });

  const tickStream = new (await import('node:stream')).Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesDone += chunk.length;
      if (bar) {
        const elapsed = (Date.now() - startedAt) / 1000;
        const since = bytesDone - (isResume ? existingBytes : 0);
        const speed = elapsed > 0 ? since / elapsed / 1_000_000 : 0;
        bar.update(bytesDone, {
          value_mb: (bytesDone / 1_000_000).toFixed(1),
          total_mb: (totalBytes / 1_000_000).toFixed(1),
          speed_mb: speed.toFixed(1),
        });
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(resp.body, tickStream, out);
    if (bar) bar.stop();
  } catch (err) {
    if (bar) bar.stop();
    throw err;
  }

  await fs.rename(partPath, destPath);
  return { model, destPath, skipped: false, failed: false };
}

export async function installModels(models: ModelEntry[], opts: InstallOptions): Promise<InstallResult[]> {
  const out: InstallResult[] = [];
  for (const m of models) {
    if (!opts.quiet) {
      console.log(chalk.dim(`\n→ ${m.displayName}  (${(m.sizeBytes / 1e9).toFixed(2)} GB)`));
    }
    try {
      const r = await installModel(m, opts);
      if (!opts.quiet) {
        if (r.failed) console.log(chalk.red(`  ✗ failed: ${r.reason}`));
        else if (r.skipped) console.log(chalk.yellow(`  ↪ skipped: ${r.reason}`));
      }
      out.push(r);
    } catch (err) {
      if (!opts.quiet) console.log(chalk.red(`  ✗ failed: ${(err as Error).message}`));
      out.push({ model: m, destPath: '', skipped: true, failed: true, reason: (err as Error).message });
    }
  }
  return out;
}
