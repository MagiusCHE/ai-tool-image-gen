import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import chalk from 'chalk';
import prompts from 'prompts';
import { loadConfig } from './core/config.js';
import { runSetup } from './setup.js';
import { runDoctor, printDoctor } from './doctor.js';
import { registerMcp } from './register-mcp.js';
import { installCli } from './install-cli.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function header(title: string): void {
  console.log();
  console.log(chalk.bold.cyan(`━━ ${title}`));
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function runBuild(): Promise<void> {
  header('build');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['tsc'], { cwd: REPO_ROOT, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tsc exited ${code}`))));
    child.on('error', reject);
  });
  // Copy workflows into dist/.
  const src = path.join(REPO_ROOT, 'src', 'workflows');
  const dst = path.join(REPO_ROOT, 'dist', 'workflows');
  await fs.mkdir(dst, { recursive: true });
  for (const f of await fs.readdir(src)) {
    await fs.copyFile(path.join(src, f), path.join(dst, f));
  }
  console.log(chalk.green('  ✓ dist/ built'));
}

async function maybeRunWizard(): Promise<boolean> {
  header('wizard (config + models)');
  const existing = await loadConfig();
  if (existing) {
    const { rerun } = await prompts({
      type: 'confirm',
      name: 'rerun',
      message: `Config already present (default model: ${existing.defaultModelId || '?'}). Re-run wizard?`,
      initial: false,
    });
    if (!rerun) {
      console.log(chalk.dim('  ↪ keeping existing config.'));
      return true;
    }
  }
  await runSetup();
  return (await loadConfig()) !== null;
}

async function runCheck(): Promise<boolean> {
  header('health check');
  const results = await runDoctor();
  printDoctor(results);
  const failed = results.some((r) => r.status === 'fail');
  return !failed;
}

type StepStatus = 'done' | 'skipped';
type CliStatus = 'user' | 'system' | 'skipped';

async function maybeRegisterMcp(): Promise<StepStatus> {
  header('register MCP server in ~/.claude.json');
  const { proceed } = await prompts({
    type: 'confirm',
    name: 'proceed',
    message: 'Add image-gen to ~/.claude.json so Claude Code can call it? (backup is taken)',
    initial: true,
  });
  if (!proceed) { console.log(chalk.dim('  ↪ skipped.')); return 'skipped'; }
  await registerMcp({ name: 'image-gen' });
  return 'done';
}

async function maybeInstallCli(): Promise<CliStatus> {
  header('install CLI on PATH');
  const { scope } = await prompts({
    type: 'select',
    name: 'scope',
    message: 'Install `image-gen` and `image-gen-mcp` on the system PATH?',
    choices: [
      { title: 'Per-user  (~/.local/bin/)', description: 'no sudo, only for the current user', value: 'user' },
      { title: 'System-wide  (/usr/local/bin/)', description: 'requires sudo, available to all users', value: 'system' },
      { title: 'Skip', description: 'do not install symlinks now', value: 'skip' },
    ],
    initial: 0,
  });

  if (!scope || scope === 'skip') {
    console.log(chalk.dim('  ↪ skipped. you can still use `pnpm step:gen` from this repo, or run `pnpm step:install-cli` later.'));
    return 'skipped';
  }

  if (scope === 'system' && process.getuid && process.getuid() !== 0) {
    console.log(chalk.yellow('  ⚠ system-wide install needs root.'));
    console.log(chalk.dim('    re-run as:'));
    console.log(chalk.dim('      sudo pnpm step:install-cli --system'));
    console.log(chalk.dim('    (or re-run the whole configure under sudo)'));
    return 'skipped';
  }

  await installCli({ system: scope === 'system' });
  return scope as 'user' | 'system';
}

function printFinalSummary(mcp: StepStatus, cli: CliStatus): void {
  console.log();
  console.log(chalk.green.bold('  ✓ configure complete'));
  console.log();
  console.log(chalk.bold('  ora puoi:'));

  // CLI section
  if (cli === 'user' || cli === 'system') {
    const scopeNote = cli === 'system' ? ' (system-wide)' : ' (per-user)';
    console.log(`    ${chalk.cyan('image-gen generate "<prompt>" -o <file.png>')}    generate an image${scopeNote}`);
    console.log(`    ${chalk.cyan('image-gen doctor')}                                check setup`);
    console.log(`    ${chalk.cyan('image-gen list-models')}                           show models`);
    if (cli === 'user') {
      const home = process.env.HOME ?? '~';
      const segments = (process.env.PATH ?? '').split(path.delimiter);
      const userBin = path.join(home, '.local', 'bin');
      if (!segments.includes(userBin)) {
        console.log(chalk.yellow(`    ⚠ ${userBin} is NOT in your PATH yet — add it to your shell rc.`));
      }
    }
  } else {
    console.log(`    ${chalk.cyan('pnpm step:gen "<prompt>" -o <file.png>')}          generate an image (from this repo)`);
    console.log(`    ${chalk.cyan('pnpm step:check')}                                 check setup`);
    console.log(chalk.dim('    (run `pnpm step:install-cli` later to expose `image-gen` on PATH)'));
  }

  // MCP section
  console.log();
  if (mcp === 'done') {
    console.log(chalk.bold('  use it from Claude Code:'));
    console.log(chalk.dim('    1. restart Claude Code so it picks up the new MCP server'));
    console.log(chalk.dim('    2. in any session, the tools  generate_image / list_models / doctor  appear automatically'));
    console.log(chalk.dim('    3. ask Claude:  "generate an icon of a fox and save it to /tmp/fox.png"'));
  } else {
    console.log(chalk.bold('  to use from Claude Code:'));
    console.log(chalk.dim('    run  `pnpm step:register-mcp`  to add the MCP server to ~/.claude.json, then restart Claude Code.'));
  }

  console.log();
}

async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n  image-gen — configure\n'));
  console.log(chalk.dim('  steps: build → wizard → check → register-mcp → install-cli'));
  console.log(chalk.dim('  each destructive step asks for confirmation and can be skipped.'));
  console.log(chalk.dim('  install-cli will also ask whether to install per-user or system-wide.\n'));

  const distOk = await fileExists(path.join(REPO_ROOT, 'dist', 'cli.js'));
  if (!distOk) {
    await runBuild();
  } else {
    const { rebuild } = await prompts({
      type: 'confirm',
      name: 'rebuild',
      message: 'dist/ already built. Re-build?',
      initial: false,
    });
    if (rebuild) await runBuild();
  }

  const wizardOk = await maybeRunWizard();
  if (!wizardOk) {
    console.log(chalk.red('\n✗ no valid config — aborting before MCP/CLI registration.'));
    process.exitCode = 1;
    return;
  }

  const checkOk = await runCheck();
  if (!checkOk) {
    const { keepGoing } = await prompts({
      type: 'confirm',
      name: 'keepGoing',
      message: 'Health check found failures. Continue anyway?',
      initial: false,
    });
    if (!keepGoing) {
      console.log(chalk.red('\n✗ aborted on failed check.'));
      process.exitCode = 1;
      return;
    }
  }

  const mcpStatus = await maybeRegisterMcp();
  const cliStatus = await maybeInstallCli();

  printFinalSummary(mcpStatus, cliStatus);
}

main().catch((err) => {
  console.error(chalk.red(`\n✗ configure failed: ${(err as Error).message}`));
  process.exit(1);
});
