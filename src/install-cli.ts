import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import chalk from 'chalk';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const BINS = ['image-gen', 'image-gen-mcp'] as const;

export interface InstallCliOptions {
  /** Install system-wide in /usr/local/bin instead of ~/.local/bin. Requires write permission (sudo). */
  system?: boolean;
}

const SYSTEM_DIR = '/usr/local/bin';

function targetDir(opts: InstallCliOptions): string {
  if (process.env.COMFY_GEN_BIN_DIR) return process.env.COMFY_GEN_BIN_DIR;
  if (opts.system) return SYSTEM_DIR;
  return path.join(os.homedir(), '.local', 'bin');
}

function isInPath(dir: string): boolean {
  const segments = (process.env.PATH ?? '').split(path.delimiter);
  return segments.includes(dir);
}

async function exists(p: string): Promise<boolean> {
  try { await fs.lstat(p); return true; } catch { return false; }
}

function permHint(err: NodeJS.ErrnoException, dir: string, opts: InstallCliOptions): string {
  if (err.code !== 'EACCES' && err.code !== 'EPERM') return err.message;
  if (opts.system) return `${err.message}\n  → ${dir} requires elevated privileges. Re-run as: sudo $(command -v node) $(realpath dist/cli.js) install-cli --system`;
  return err.message;
}

export async function installCli(opts: InstallCliOptions = {}): Promise<void> {
  const dir = targetDir(opts);

  // The bin shebangs `import('../dist/...')`, so dist must exist.
  const distCli = path.join(REPO_ROOT, 'dist', 'cli.js');
  if (!(await exists(distCli))) {
    throw new Error(`dist/ not built — run \`pnpm step:build\` (or \`npm run step:build\`) first.`);
  }

  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new Error(permHint(err as NodeJS.ErrnoException, dir, opts));
  }

  console.log(chalk.dim(`  target: ${dir}${opts.system ? '  (system-wide)' : '  (per-user)'}\n`));

  for (const name of BINS) {
    const src = path.join(REPO_ROOT, 'bin', name);
    const dst = path.join(dir, name);
    if (!(await exists(src))) throw new Error(`source missing: ${src}`);
    try {
      if (await exists(dst)) await fs.unlink(dst);
      await fs.symlink(src, dst);
    } catch (err) {
      throw new Error(permHint(err as NodeJS.ErrnoException, dir, opts));
    }
    console.log(`  ${chalk.green('✓')} ${dst}  →  ${src}`);
  }

  console.log();
  if (!isInPath(dir)) {
    console.log(chalk.yellow(`  ⚠ ${dir} is not in your $PATH.`));
    console.log(chalk.dim('    add this to your shell rc file:'));
    console.log(chalk.dim(`      export PATH="${dir}:$PATH"`));
    console.log(chalk.dim('    or set $COMFY_GEN_BIN_DIR to a dir already in PATH and re-run.'));
  } else {
    console.log(chalk.green(`  ${BINS.join(' and ')} are now available globally.`));
    console.log(chalk.dim('  verify with: `image-gen doctor`'));
  }
}

export async function uninstallCli(opts: InstallCliOptions = {}): Promise<void> {
  const dir = targetDir(opts);
  for (const name of BINS) {
    const dst = path.join(dir, name);
    if (!(await exists(dst))) {
      console.log(`  ${chalk.dim('·')} ${dst}  (not present)`);
      continue;
    }
    const real = await fs.realpath(dst).catch(() => '');
    const expected = path.join(REPO_ROOT, 'bin', name);
    if (real !== expected) {
      console.log(`  ${chalk.yellow('!')} ${dst} points to ${real} (not us) — leaving it alone`);
      continue;
    }
    try {
      await fs.unlink(dst);
      console.log(`  ${chalk.green('✓')} removed ${dst}`);
    } catch (err) {
      throw new Error(permHint(err as NodeJS.ErrnoException, dir, opts));
    }
  }
}
