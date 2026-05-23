import { promises as fs } from 'node:fs';
import path from 'node:path';
import { statfs } from 'node:fs/promises';
import chalk from 'chalk';
import { ComfyClient } from './core/client.js';
import { loadConfig, configPath } from './core/config.js';
import { MODEL_REGISTRY } from './core/registry.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function freeBytes(p: string): Promise<number> {
  try {
    const s = await statfs(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return 0; }
}

export async function runDoctor(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const cfgFile = configPath();
  const cfg = await loadConfig();

  if (!cfg) {
    results.push({
      name: 'config',
      status: 'fail',
      detail: `not found at ${cfgFile}`,
      hint: 'run `pnpm step:wizard`',
    });
    return results;
  }
  results.push({ name: 'config', status: 'ok', detail: cfgFile });

  if (await fileExists(path.join(cfg.comfyuiPath, 'main.py'))) {
    results.push({ name: 'comfyui path', status: 'ok', detail: cfg.comfyuiPath });
  } else {
    results.push({
      name: 'comfyui path',
      status: 'fail',
      detail: `${cfg.comfyuiPath} (no main.py)`,
      hint: 're-run `pnpm step:wizard` (or edit ' + cfgFile + ')',
    });
  }

  const client = new ComfyClient(cfg.comfyuiUrl);
  try {
    const stats = await client.systemStats();
    const dev = stats.devices?.[0];
    const vramGb = dev ? (dev.vram_total / 1e9).toFixed(1) : '?';
    results.push({ name: 'comfyui api', status: 'ok', detail: `${cfg.comfyuiUrl} · ${dev?.name ?? 'no device'} · ${vramGb} GB VRAM` });
  } catch (err) {
    results.push({
      name: 'comfyui api',
      status: 'fail',
      detail: `${cfg.comfyuiUrl} unreachable: ${(err as Error).message}`,
      hint: 'is ComfyUI running? start it with `python main.py` and verify the port matches `comfyuiUrl`',
    });
  }

  for (const m of MODEL_REGISTRY) {
    if (!cfg.installedModelIds.includes(m.id)) continue;
    const p = path.join(cfg.comfyuiPath, 'models', m.destDir, m.filename);
    if (await fileExists(p)) {
      const sz = (await fs.stat(p)).size;
      results.push({ name: `model:${m.id}`, status: 'ok', detail: `${p} (${(sz / 1e9).toFixed(2)} GB)` });
    } else {
      results.push({
        name: `model:${m.id}`,
        status: 'fail',
        detail: `missing at ${p}`,
        hint: `re-run \`pnpm step:wizard\` to download ${m.displayName}`,
      });
    }
  }

  if (cfg.defaultModelId === 'zimage') {
    const required = ['z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors'];
    const present = await Promise.all(required.map(async (f) => {
      for (const dir of ['diffusion_models', 'text_encoders', 'vae', 'checkpoints']) {
        if (await fileExists(path.join(cfg.comfyuiPath, 'models', dir, f))) return true;
      }
      return false;
    }));
    const missing = required.filter((_, i) => !present[i]);
    if (missing.length > 0) {
      results.push({
        name: 'zimage stack',
        status: 'fail',
        detail: `default model is zimage but missing: ${missing.join(', ')}`,
        hint: 're-run `pnpm step:wizard` or change defaultModelId in the config file',
      });
    } else {
      results.push({ name: 'zimage stack', status: 'ok', detail: 'all 3 files present' });
    }
  }

  const bg = path.join(cfg.comfyuiPath, 'models', 'background_removal');
  if (await fileExists(bg)) {
    const files = (await fs.readdir(bg)).filter((f) => f.endsWith('.pth') || f.endsWith('.safetensors'));
    results.push({ name: 'bg-removal models', status: files.length > 0 ? 'ok' : 'warn', detail: `${files.length} file(s) in ${bg}` });
  } else {
    results.push({ name: 'bg-removal models', status: 'warn', detail: `no ${bg} dir`, hint: '--transparent will fail without a BiRefNet model installed' });
  }

  const free = await freeBytes(cfg.comfyuiPath);
  results.push({
    name: 'disk free',
    status: free < 5e9 ? 'warn' : 'ok',
    detail: `${(free / 1e9).toFixed(1)} GB free at ${cfg.comfyuiPath}`,
  });

  return results;
}

export function printDoctor(results: CheckResult[]): void {
  console.log();
  for (const r of results) {
    const icon = r.status === 'ok' ? chalk.green('✓') : r.status === 'warn' ? chalk.yellow('!') : chalk.red('✗');
    const name = chalk.bold(r.name.padEnd(22));
    console.log(`  ${icon} ${name} ${r.detail}`);
    if (r.hint && r.status !== 'ok') console.log(`    ${chalk.dim('→ ' + r.hint)}`);
  }
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log();
  if (fails === 0 && warns === 0) console.log(chalk.green('  all good\n'));
  else if (fails === 0) console.log(chalk.yellow(`  ${warns} warning(s)\n`));
  else console.log(chalk.red(`  ${fails} failure(s), ${warns} warning(s)\n`));
}
