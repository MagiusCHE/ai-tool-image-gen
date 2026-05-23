import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import prompts from 'prompts';
import chalk from 'chalk';

interface McpStdioEntry { command: string; args: string[]; env?: Record<string, string>; }
interface McpHttpEntry { type: 'http'; url: string; headers?: Record<string, string>; }
type McpEntry = McpStdioEntry | McpHttpEntry;

interface ClaudeConfig {
  mcpServers?: Record<string, McpEntry>;
  [k: string]: unknown;
}

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), '.claude.json');

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function backupConfig(): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${CLAUDE_CONFIG_PATH}.bak-${ts}`;
  await fs.copyFile(CLAUDE_CONFIG_PATH, backup);
  return backup;
}

async function loadClaudeConfig(): Promise<ClaudeConfig> {
  if (!(await fileExists(CLAUDE_CONFIG_PATH))) return {};
  const raw = await fs.readFile(CLAUDE_CONFIG_PATH, 'utf-8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

async function writeClaudeConfig(cfg: ClaudeConfig): Promise<void> {
  await fs.writeFile(CLAUDE_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

async function resolveBinary(): Promise<string> {
  const { execSync } = await import('node:child_process');
  try {
    const found = execSync('command -v image-gen-mcp', { encoding: 'utf-8' }).trim();
    if (found) return found;
  } catch { /* not on PATH */ }
  return path.resolve(process.cwd(), 'bin', 'image-gen-mcp');
}

export interface RegisterMcpOptions {
  name?: string;
  remoteUrl?: string;
  token?: string;
}

export async function registerMcp(opts: RegisterMcpOptions = {}): Promise<void> {
  const name = opts.name ?? 'image-gen';
  const cfg = await loadClaudeConfig();
  cfg.mcpServers ??= {};

  if (cfg.mcpServers[name]) {
    const { overwrite } = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: `mcpServers.${name} already exists in ~/.claude.json. Overwrite?`,
      initial: false,
    });
    if (!overwrite) {
      console.log(chalk.dim('  aborted, ~/.claude.json untouched.\n'));
      return;
    }
  }

  let entry: McpEntry;
  if (opts.remoteUrl) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    entry = { type: 'http', url: opts.remoteUrl, headers };
  } else {
    const bin = await resolveBinary();
    entry = { command: bin, args: [], env: {} };
  }

  if (await fileExists(CLAUDE_CONFIG_PATH)) {
    const backup = await backupConfig();
    console.log(chalk.dim(`  backup → ${backup}`));
  }

  cfg.mcpServers[name] = entry;
  await writeClaudeConfig(cfg);

  console.log(chalk.green(`\n✓ registered MCP server '${name}' in ~/.claude.json`));
  console.log(chalk.dim('  restart Claude Code to pick up the new server.\n'));
}
