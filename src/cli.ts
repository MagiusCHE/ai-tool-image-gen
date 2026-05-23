#!/usr/bin/env node
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from './core/config.js';
import { generate, type WorkflowFamily, type TransparentMode } from './core/generate.js';
import { runSetup } from './setup.js';
import { runDoctor, printDoctor } from './doctor.js';
import { registerMcp } from './register-mcp.js';
import { installCli, uninstallCli } from './install-cli.js';

const program = new Command();
program
  .name('image-gen')
  .description('Generate images via a local ComfyUI instance — CLI + MCP server.')
  .version('0.1.0');

program
  .command('setup')
  .description('Interactive wizard: detects ComfyUI, downloads recommended models, writes config.')
  .action(async () => {
    try { await runSetup(); } catch (err) {
      console.error(chalk.red(`setup failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('Verify config, ComfyUI connectivity, and installed models.')
  .option('--json', 'machine-readable output')
  .action(async (opts) => {
    const results = await runDoctor();
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printDoctor(results);
    }
    if (results.some((r) => r.status === 'fail')) process.exit(1);
  });

program
  .command('generate')
  .alias('gen')
  .description('Generate an image from a prompt.')
  .argument('<prompt>', 'text prompt')
  .option('-o, --output <path>', 'output PNG path', '')
  .option('-m, --model <id>', 'zimage|flux|sdxl', '')
  .option('-s, --size <wxh>', 'image size, e.g. 1024x1024', '1024x1024')
  .option('-n, --negative <text>', 'negative prompt (only sdxl honours this)', '')
  .option('--steps <n>', 'override sampling steps', '')
  .option('--seed <n>', 'fixed seed (default: random)', '')
  .option('--transparent', 'shorthand for --transparent-mode=cutout (BiRefNet background removal)')
  .option('--transparent-mode <mode>', 'cutout | outer-fill. cutout: remove background via BiRefNet (photos/products). outer-fill: keep the subject opaque and make only the near-white outer background transparent via corner flood-fill (icons/logos).')
  .option('--outer-fill-erode <n>', 'pixels to shrink the alpha mask after outer-fill flood (default 2; 0 disables). Eats the residual anti-aliased halo around dark outlines.')
  .option('--quiet', 'no progress')
  .option('--json', 'JSON result on stdout')
  .action(async (prompt: string, opts) => {
    const cfg = await loadConfig();
    if (!cfg) {
      console.error(chalk.red('no config — run `pnpm setup` (or `image-gen setup`) first.'));
      process.exit(1);
    }
    const sizeMatch = /^(\d+)x(\d+)$/.exec(opts.size);
    if (!sizeMatch) {
      console.error(chalk.red(`invalid --size '${opts.size}' (expected WxH like 1024x1024)`));
      process.exit(1);
    }
    const width = parseInt(sizeMatch[1]!, 10);
    const height = parseInt(sizeMatch[2]!, 10);

    const family: WorkflowFamily | undefined = opts.model ? (opts.model as WorkflowFamily) : undefined;
    if (family && !['zimage', 'flux', 'sdxl'].includes(family)) {
      console.error(chalk.red(`invalid --model '${family}' (expected zimage|flux|sdxl)`));
      process.exit(1);
    }

    const outputPath = opts.output || path.resolve(process.cwd(), `generated-${Date.now()}.png`);
    const seed = opts.seed ? parseInt(opts.seed, 10) : undefined;
    const steps = opts.steps ? parseInt(opts.steps, 10) : undefined;

    let transparent: TransparentMode | boolean | undefined;
    if (opts.transparentMode) {
      if (opts.transparentMode !== 'cutout' && opts.transparentMode !== 'outer-fill') {
        console.error(chalk.red(`invalid --transparent-mode '${opts.transparentMode}' (expected cutout|outer-fill)`));
        process.exit(1);
      }
      transparent = opts.transparentMode;
    } else if (opts.transparent) {
      transparent = 'cutout';
    }

    let outerFillErode: number | undefined;
    if (opts.outerFillErode !== undefined) {
      const n = parseInt(opts.outerFillErode, 10);
      if (!Number.isFinite(n) || n < 0 || n > 8) {
        console.error(chalk.red(`invalid --outer-fill-erode '${opts.outerFillErode}' (expected integer 0–8)`));
        process.exit(1);
      }
      outerFillErode = n;
    }

    const spinner = opts.quiet || opts.json ? null : ora('queueing...').start();
    try {
      const result = await generate(cfg, {
        prompt,
        outputPath,
        model: family,
        width,
        height,
        seed,
        steps,
        negative: opts.negative,
        transparent,
        outerFillErode,
        onProgress: (p) => {
          if (!spinner) return;
          if (p.stage === 'sampling' && p.value !== undefined && p.max) {
            spinner.text = `sampling ${p.value}/${p.max}`;
          } else {
            spinner.text = p.stage;
          }
        },
      });
      spinner?.succeed(`saved → ${result.path}  (${(result.durationMs / 1000).toFixed(1)}s, seed=${result.seed}, model=${result.family})`);
      if (opts.json) {
        console.log(JSON.stringify({ success: true, ...result }, null, 2));
      }
    } catch (err) {
      spinner?.fail(`generate failed: ${(err as Error).message}`);
      if (opts.json) {
        console.log(JSON.stringify({ success: false, error: (err as Error).message }));
      }
      process.exit(1);
    }
  });

program
  .command('register-mcp')
  .description('Register image-gen as an MCP server in ~/.claude.json.')
  .option('--remote <url>', 'register a remote HTTP MCP server instead of local stdio')
  .option('--token <bearer>', 'bearer token (for --remote)')
  .option('--name <name>', 'mcp server name', 'image-gen')
  .action(async (opts) => {
    try { await registerMcp({ remoteUrl: opts.remote, token: opts.token, name: opts.name }); }
    catch (err) {
      console.error(chalk.red(`register-mcp failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command('install-cli')
  .description('Symlink `image-gen` and `image-gen-mcp` so they work from any directory. Defaults to ~/.local/bin (per-user). Package-manager agnostic.')
  .option('--system', 'install system-wide in /usr/local/bin (requires sudo)')
  .action(async (opts) => {
    try { await installCli({ system: Boolean(opts.system) }); } catch (err) {
      console.error(chalk.red(`install-cli failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command('uninstall-cli')
  .description('Remove the symlinks created by `install-cli`. Use --system if they were installed system-wide.')
  .option('--system', 'uninstall from /usr/local/bin (requires sudo)')
  .action(async (opts) => {
    try { await uninstallCli({ system: Boolean(opts.system) }); } catch (err) {
      console.error(chalk.red(`uninstall-cli failed: ${(err as Error).message}`));
      process.exit(1);
    }
  });

program
  .command('list-models')
  .description('Print the model registry, marking what is installed.')
  .action(async () => {
    const { MODEL_REGISTRY } = await import('./core/registry.js');
    const cfg = await loadConfig();
    for (const m of MODEL_REGISTRY) {
      const tag = cfg?.installedModelIds.includes(m.id) ? chalk.green('[installed]') : chalk.dim('[available]');
      console.log(`  ${tag} ${chalk.bold(m.id.padEnd(28))} ${m.displayName} (${(m.sizeBytes / 1e9).toFixed(1)} GB)`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(err.message));
  process.exit(1);
});
