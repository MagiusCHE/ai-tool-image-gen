import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ImageGenConfig {
  /** Filesystem path to ComfyUI installation (where `models/` lives). */
  comfyuiPath: string;
  /** Base URL of the running ComfyUI API. */
  comfyuiUrl: string;
  /** Default model id (from registry) for `generate` when -m is not specified. */
  defaultModelId: string;
  /** IDs of models the user installed via setup. */
  installedModelIds: string[];
  /** Optional Civitai API key (env CIVITAI_API_KEY takes precedence). */
  civitaiApiKey?: string;
  /** When the config was last written (ISO). */
  updatedAt: string;
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'image-gen');
}

function configFile(): string {
  return path.join(configDir(), 'config.json');
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function loadConfig(): Promise<ImageGenConfig | null> {
  const f = configFile();
  if (!(await fileExists(f))) return null;
  return JSON.parse(await fs.readFile(f, 'utf-8'));
}

export async function saveConfig(cfg: ImageGenConfig): Promise<void> {
  const withTs: ImageGenConfig = { ...cfg, updatedAt: new Date().toISOString() };
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(configFile(), JSON.stringify(withTs, null, 2) + '\n', 'utf-8');
}

export function configPath(): string {
  return configFile();
}

/** Resolve the absolute path of a model file inside ComfyUI's models tree. */
export function modelPath(cfg: ImageGenConfig, destDir: string, filename: string): string {
  return path.join(cfg.comfyuiPath, 'models', destDir, filename);
}
