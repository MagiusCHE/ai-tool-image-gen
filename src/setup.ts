import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import prompts from 'prompts';
import chalk from 'chalk';
import { DEFAULT_INSTALL_IDS, MODEL_REGISTRY, type ModelEntry } from './core/registry.js';
import { loadConfig, saveConfig, type ImageGenConfig, configPath } from './core/config.js';
import { installModels } from './core/installer.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function pathHasComfyUI(p: string): Promise<boolean> {
  try {
    await fs.access(path.join(p, 'main.py'));
    await fs.access(path.join(p, 'models'));
    return true;
  } catch { return false; }
}

async function scanInstalledModels(comfyuiPath: string): Promise<Set<string>> {
  const installed = new Set<string>();
  for (const m of MODEL_REGISTRY) {
    const p = path.join(comfyuiPath, 'models', m.destDir, m.filename);
    try { await fs.access(p); installed.add(m.id); } catch { /* missing */ }
  }
  return installed;
}

function banner(): void {
  console.log(chalk.bold.cyan('\n  image-gen — setup wizard\n'));
  console.log(chalk.dim('  ComfyUI wrapper · CLI + MCP\n'));
}

async function copyWorkflowsToComfyUI(comfyuiPath: string): Promise<void> {
  const target = path.join(comfyuiPath, 'user', 'default', 'workflows');
  try {
    await fs.mkdir(target, { recursive: true });
    const wfDir = path.join(__dirname, 'workflows');
    const files = await fs.readdir(wfDir);
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      await fs.copyFile(path.join(wfDir, f), path.join(target, `image-gen-${f}`));
    }
  } catch (err) {
    console.log(chalk.yellow(`  (could not copy workflows to ComfyUI UI dir: ${(err as Error).message})`));
  }
}

export async function runSetup(): Promise<void> {
  banner();

  const existing = await loadConfig();
  if (existing) {
    const { proceed } = await prompts({
      type: 'confirm',
      name: 'proceed',
      message: `Found existing config (comfyuiPath=${existing.comfyuiPath}). Re-run setup?`,
      initial: false,
    });
    if (!proceed) {
      console.log(chalk.dim('  Aborted.\n'));
      return;
    }
  }

  // Priority for prompt defaults: existing config > env var > empty.
  const defaultPath = existing?.comfyuiPath ?? process.env.COMFYUI_PATH ?? '';
  const { comfyuiPath } = await prompts({
    type: 'text',
    name: 'comfyuiPath',
    message: 'ComfyUI install path (the dir containing main.py and models/)',
    initial: defaultPath,
    validate: (v: string) => (v.trim().length > 0 ? true : 'required — set $COMFYUI_PATH or type it here'),
  });
  if (!comfyuiPath) { console.log(chalk.red('  cancelled.\n')); return; }

  if (!(await pathHasComfyUI(comfyuiPath))) {
    console.log(chalk.yellow(`  ⚠ ${comfyuiPath} does not look like a ComfyUI installation (missing main.py or models/). Continuing anyway.`));
  }

  const defaultUrl = existing?.comfyuiUrl ?? process.env.COMFYUI_URL ?? '';
  const { comfyuiUrl } = await prompts({
    type: 'text',
    name: 'comfyuiUrl',
    message: 'ComfyUI API URL (e.g. http://127.0.0.1:8188)',
    initial: defaultUrl,
    validate: (v: string) => /^https?:\/\//.test(v) ? true : 'must start with http(s):// — set $COMFYUI_URL or type it',
  });
  if (!comfyuiUrl) { console.log(chalk.red('  cancelled.\n')); return; }

  console.log(chalk.bold('\n› scanning installed models...'));
  const installed = await scanInstalledModels(comfyuiPath);
  console.log(chalk.dim(`  found ${installed.size} matching files in ${comfyuiPath}/models/`));

  const candidates = MODEL_REGISTRY.filter((m) => m.source !== 'local');
  const preSelectedCount = candidates.filter((m) => !installed.has(m.id) && DEFAULT_INSTALL_IDS.includes(m.id)).length;
  const preSelectedBytes = candidates
    .filter((m) => !installed.has(m.id) && DEFAULT_INSTALL_IDS.includes(m.id))
    .reduce((sum, m) => sum + m.sizeBytes, 0);

  console.log(chalk.dim(`  ${preSelectedCount} item(s) pre-selected by default (${(preSelectedBytes / 1e9).toFixed(1)} GB total)`));
  console.log(chalk.dim('  use ↑↓ to move, SPACE to toggle, RETURN to confirm.\n'));

  const choices = candidates.map((m: ModelEntry) => {
    const present = installed.has(m.id);
    const sizeGb = (m.sizeBytes / 1e9).toFixed(1);
    const tag = present
      ? chalk.green('[present]')
      : DEFAULT_INSTALL_IDS.includes(m.id) ? chalk.cyan('[default ✓]') : '';
    return {
      title: `${m.displayName}  ${chalk.dim(`(${sizeGb} GB)`)}  ${tag}`,
      value: m.id,
      selected: !present && DEFAULT_INSTALL_IDS.includes(m.id),
      disabled: present,
    };
  });

  const { selectedIds } = await prompts({
    type: 'multiselect',
    name: 'selectedIds',
    message: 'Models to download',
    choices,
    instructions: true,
    hint: '— items marked [default ✓] are already checked, deselect with SPACE if not wanted',
  });

  const toDownload = (selectedIds ?? []).map((id: string) => MODEL_REGISTRY.find((m) => m.id === id)!).filter(Boolean);

  let civitaiKey: string | undefined = process.env.CIVITAI_API_KEY;
  let installResults: { failed: boolean; reason?: string; model: ModelEntry }[] = [];

  if (toDownload.length === 0) {
    console.log(chalk.dim('\n  no downloads selected.\n'));
  } else {
    const totalGb = (toDownload.reduce((s: number, m: ModelEntry) => s + m.sizeBytes, 0) / 1e9).toFixed(1);
    console.log(chalk.bold('\n  about to download:'));
    for (const m of toDownload as ModelEntry[]) {
      console.log(`    · ${chalk.cyan(m.id.padEnd(28))} ${(m.sizeBytes / 1e9).toFixed(1)} GB`);
    }
    console.log(chalk.dim(`    total: ${totalGb} GB\n`));

    const { confirm } = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: 'Proceed with download?',
      initial: true,
    });
    if (!confirm) {
      console.log(chalk.dim('  download skipped.\n'));
    } else {
      if (!civitaiKey && toDownload.some((m: ModelEntry) => m.source === 'civitai' && m.requiresApiKey)) {
        const { key } = await prompts({
          type: 'password',
          name: 'key',
          message: 'Civitai API key (will not be saved unless you confirm next)',
        });
        if (key) {
          civitaiKey = key;
          const { save } = await prompts({ type: 'confirm', name: 'save', message: 'Save Civitai API key in config?', initial: false });
          if (!save) civitaiKey = undefined;
        }
      }
      console.log(chalk.bold(`\n› downloading ${toDownload.length} model(s)...`));
      installResults = await installModels(toDownload, { comfyuiPath, civitaiApiKey: civitaiKey });
    }
  }

  console.log(chalk.bold('\n› copying workflows into ComfyUI UI dir...'));
  await copyWorkflowsToComfyUI(comfyuiPath);

  const installedAfter = await scanInstalledModels(comfyuiPath);
  const defaultModelId = installedAfter.has('zimage-turbo') && installedAfter.has('qwen3-4b-encoder') && installedAfter.has('zimage-vae')
    ? 'zimage'
    : installedAfter.has('flux-schnell-fp8') && installedAfter.has('clip-l') && installedAfter.has('t5xxl-fp8') && installedAfter.has('flux-vae')
      ? 'flux'
      : installedAfter.has('dreamshaper-xl-turbo') || installedAfter.has('sdxl-base')
        ? 'sdxl'
        : '';

  const cfg: ImageGenConfig = {
    comfyuiPath,
    comfyuiUrl,
    defaultModelId,
    installedModelIds: Array.from(installedAfter),
    civitaiApiKey: civitaiKey,
    updatedAt: new Date().toISOString(),
  };
  await saveConfig(cfg);

  const failures = installResults.filter((r) => r.failed);
  if (failures.length > 0) {
    console.log(chalk.red(`\n✗ setup finished with ${failures.length} failure(s):`));
    for (const f of failures) {
      console.log(chalk.red(`  · ${f.model.id}: ${f.reason}`));
    }
    console.log(chalk.dim(`\n  config saved to: ${configPath()}`));
    console.log(chalk.dim('  re-run `pnpm step:wizard` to retry, or `pnpm step:check` for details.\n'));
    process.exitCode = 1;
    return;
  }

  if (!defaultModelId) {
    console.log(chalk.red('\n✗ setup finished but no model family is fully installed.'));
    console.log(chalk.dim('  at least one of: zimage / flux / sdxl stacks must be complete.'));
    console.log(chalk.dim('  re-run `pnpm step:wizard` and pick the missing files.\n'));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.green('\n✓ setup complete'));
  console.log(chalk.dim(`  config: ${configPath()}`));
  console.log(chalk.dim(`  default model family: ${defaultModelId}`));
  console.log();
  console.log(chalk.bold('  next steps:'));
  console.log(`    ${chalk.cyan('pnpm step:check')}            verify setup`);
  console.log(`    ${chalk.cyan('pnpm step:gen "a fox"')}      smoke test`);
  console.log(`    ${chalk.cyan('pnpm step:install-cli')}      expose image-gen on PATH`);
  console.log(`    ${chalk.cyan('pnpm step:register-mcp')}     register MCP server for Claude Code`);
  console.log(chalk.dim(`    (or just \`pnpm configure\` to run all of the above in sequence)\n`));
}
