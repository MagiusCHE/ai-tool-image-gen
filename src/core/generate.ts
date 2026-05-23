import { promises as fs } from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import sharp from 'sharp';
import { ComfyClient } from './client.js';
import type { ImageGenConfig } from './config.js';

export type TransparentMode = 'cutout' | 'outer-fill';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// In dev (`tsx`), this file lives at src/core; in build, at dist/core. The workflow JSONs
// live at src/workflows / dist/workflows respectively — i.e. one level up + `workflows`.
const WORKFLOW_DIR = path.join(__dirname, '..', 'workflows');

export type WorkflowFamily = 'zimage' | 'flux' | 'sdxl';

export interface GenerateOptions {
  prompt: string;
  outputPath: string;
  model?: WorkflowFamily;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  negative?: string;
  /**
   * Transparency strategy:
   * - `'cutout'` (or `true`): run BiRefNet background removal on the generated image
   *   to produce an RGBA PNG with the subject isolated. Best for product photos.
   * - `'outer-fill'`: generate opaque, then make the near-white exterior transparent
   *   via flood-fill from the four corners. Best for app icons / logos with a solid
   *   coloured shape on a white outer background (interior whites are preserved).
   * - `false` / undefined: no transparency processing.
   */
  transparent?: TransparentMode | boolean;
  /**
   * Only used by `outer-fill`. After the flood-fill, shrink the opaque silhouette by
   * this many pixels to eat the residual anti-aliased halo of grey pixels that the
   * flood-fill leaves between the dark border and the transparent exterior.
   * Default 2. Set to 0 to disable. Pure-white outer backgrounds without a coloured
   * outline usually need 0–1; outlined icons (black/dark borders) need 2.
   */
  outerFillErode?: number;
  onProgress?: (info: { stage: string; value?: number; max?: number }) => void;
}

export interface GenerateResult {
  path: string;
  seed: number;
  durationMs: number;
  family: WorkflowFamily;
}

const DEFAULT_STEPS: Record<WorkflowFamily, number> = {
  zimage: 8,
  flux: 4,
  sdxl: 8,
};

interface FamilyFiles {
  unet?: { dir: string; name: string };
  clip?: { dir: string; name: string };
  clip2?: { dir: string; name: string };
  vae?: { dir: string; name: string };
  ckpt?: { dir: string; name: string };
}

const FAMILY_FILES: Record<WorkflowFamily, FamilyFiles> = {
  zimage: {
    unet: { dir: 'diffusion_models', name: 'z_image_turbo_bf16.safetensors' },
    clip: { dir: 'text_encoders', name: 'qwen_3_4b.safetensors' },
    vae: { dir: 'vae', name: 'ae.safetensors' },
  },
  flux: {
    unet: { dir: 'unet', name: 'flux1-schnell-fp8.safetensors' },
    clip: { dir: 'clip', name: 'clip_l.safetensors' },
    clip2: { dir: 'clip', name: 't5xxl_fp8_e4m3fn.safetensors' },
    vae: { dir: 'vae', name: 'flux_vae.safetensors' },
  },
  sdxl: {
    ckpt: { dir: 'checkpoints', name: 'dreamshaperXL_v21TurboDPMSDE.safetensors' },
  },
};

const BG_REMOVAL_FILE = { dir: 'background_removal', name: 'birefnet.safetensors' };

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Returns the list of files required by `family` that are missing from disk. */
async function missingFiles(cfg: ImageGenConfig, family: WorkflowFamily, transparent: boolean): Promise<string[]> {
  const required = Object.values(FAMILY_FILES[family]);
  if (transparent) required.push(BG_REMOVAL_FILE);
  const missing: string[] = [];
  for (const f of required) {
    const full = path.join(cfg.comfyuiPath, 'models', f.dir, f.name);
    if (!(await fileExists(full))) missing.push(`${f.dir}/${f.name}`);
  }
  return missing;
}

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

async function loadWorkflow(name: string): Promise<Workflow> {
  const p = path.join(WORKFLOW_DIR, name);
  const raw = await fs.readFile(p, 'utf-8');
  return JSON.parse(raw);
}

function substitute(wf: Workflow, replacements: Record<string, string | number>): Workflow {
  const json = JSON.stringify(wf);
  const replaced = json.replace(/"%([A-Z_]+)%"|%([A-Z_]+)%/g, (full, quotedKey, bareKey) => {
    const key = quotedKey ?? bareKey;
    if (!(key in replacements)) return full;
    const value = replacements[key];
    if (quotedKey) {
      return typeof value === 'string' ? JSON.stringify(value) : String(value);
    }
    return String(value);
  });
  return JSON.parse(replaced);
}

function pickRandomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

function injectTransparentPostprocess(wf: Workflow, imageNodeId: string): Workflow {
  const next: Workflow = { ...wf };
  if (next.save) delete next.save;
  next.bg_model = {
    class_type: 'LoadBackgroundRemovalModel',
    inputs: { bg_removal_name: 'birefnet.safetensors' },
  };
  next.bg_mask = {
    class_type: 'RemoveBackground',
    inputs: { image: [imageNodeId, 0], bg_removal_model: ['bg_model', 0] },
  };
  next.rgba = {
    class_type: 'JoinImageWithAlpha',
    inputs: { image: [imageNodeId, 0], alpha: ['bg_mask', 0] },
  };
  next.save = {
    class_type: 'SaveImage',
    inputs: { filename_prefix: 'image-gen-rgba', images: ['rgba', 0] },
  };
  return next;
}

function decodeNodeIdFor(family: WorkflowFamily): string {
  if (family === 'zimage') return '8';
  return 'decode';
}

function normaliseTransparent(t: TransparentMode | boolean | undefined): TransparentMode | undefined {
  if (t === true) return 'cutout';
  if (t === false || t === undefined) return undefined;
  return t;
}

export async function generate(cfg: ImageGenConfig, opts: GenerateOptions): Promise<GenerateResult> {
  const family: WorkflowFamily = opts.model ?? (cfg.defaultModelId as WorkflowFamily) ?? 'zimage';
  if (!FAMILY_FILES[family]) throw new Error(`Unsupported model family: ${family}`);

  const width = opts.width ?? 1024;
  const height = opts.height ?? 1024;
  const steps = opts.steps ?? DEFAULT_STEPS[family];
  const seed = opts.seed ?? pickRandomSeed();
  const negative = opts.negative ?? '';
  const transparentMode = normaliseTransparent(opts.transparent);

  // Only `cutout` needs BiRefNet weights; `outer-fill` runs entirely in sharp post-processing.
  const missing = await missingFiles(cfg, family, transparentMode === 'cutout');
  if (missing.length > 0) {
    throw new Error(
      `cannot generate: ${missing.length} required file(s) missing for model '${family}'` +
      (transparentMode === 'cutout' ? ' with transparent=cutout' : '') +
      `:\n  · ${missing.join('\n  · ')}\n` +
      `run \`pnpm step:wizard\` (or \`image-gen setup\`) to download them.`,
    );
  }

  const files = FAMILY_FILES[family];
  let wf: Workflow;
  switch (family) {
    case 'zimage': {
      wf = await loadWorkflow('zimage_turbo.json');
      wf = substitute(wf, {
        PROMPT: opts.prompt,
        WIDTH: width,
        HEIGHT: height,
        SEED: seed,
        STEPS: steps,
        MODEL: files.unet!.name,
        CLIP: files.clip!.name,
        VAE: files.vae!.name,
      });
      break;
    }
    case 'flux': {
      wf = await loadWorkflow('flux_schnell.json');
      wf = substitute(wf, {
        PROMPT: opts.prompt,
        WIDTH: width,
        HEIGHT: height,
        SEED: seed,
        STEPS: steps,
        MODEL: files.unet!.name,
        CLIP1: files.clip!.name,
        CLIP2: files.clip2!.name,
        VAE: files.vae!.name,
      });
      break;
    }
    case 'sdxl': {
      wf = await loadWorkflow('sdxl_turbo.json');
      wf = substitute(wf, {
        PROMPT: opts.prompt,
        NEGATIVE: negative,
        WIDTH: width,
        HEIGHT: height,
        SEED: seed,
        STEPS: steps,
        MODEL: files.ckpt!.name,
      });
      break;
    }
  }

  if (transparentMode === 'cutout') {
    wf = injectTransparentPostprocess(wf, decodeNodeIdFor(family));
  }

  const client = new ComfyClient(cfg.comfyuiUrl);
  const startedAt = Date.now();
  opts.onProgress?.({ stage: 'queued' });
  const { prompt_id } = await client.queuePrompt(wf);

  let savedImage: { filename: string; subfolder: string; type: 'output' | 'temp' | 'input' } | null = null;
  for await (const ev of client.streamEvents(prompt_id)) {
    if (ev.type === 'progress') {
      opts.onProgress?.({ stage: 'sampling', value: ev.value, max: ev.max });
    } else if (ev.type === 'executing') {
      if (ev.node !== null) opts.onProgress?.({ stage: `node:${ev.node}` });
    } else if (ev.type === 'executed') {
      if (ev.images.length > 0) savedImage = ev.images[0]!;
    } else if (ev.type === 'execution_error') {
      throw new Error(`ComfyUI execution error: ${ev.message}`);
    }
  }
  if (!savedImage) throw new Error('ComfyUI completed but no image was emitted.');

  const buf = await client.fetchImage(savedImage);
  await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });

  if (transparentMode === 'outer-fill') {
    const erode = opts.outerFillErode ?? 2;
    const processed = await makeOuterTransparent(buf, 245, 180, erode);
    await fs.writeFile(opts.outputPath, processed);
  } else {
    await fs.writeFile(opts.outputPath, buf);
  }

  return {
    path: opts.outputPath,
    seed,
    durationMs: Date.now() - startedAt,
    family,
  };
}

/**
 * Convert the outer background to transparent via 4-corner flood-fill on the alpha
 * channel. Interior white regions (e.g. white shapes inside a coloured icon) stay
 * opaque because the BFS only walks pixels reachable from the borders.
 *
 * Two thresholds give a graduated alpha so soft shadows / anti-aliased halos around
 * the subject fade out smoothly instead of leaving a hard fringe:
 *   - pixels at or above `whiteThreshold` (≈pure white)  → fully transparent (α=0)
 *   - pixels at or below `shadowThreshold` (clearly grey/dark) → stop the flood
 *   - pixels in between (the halo)                       → α scaled linearly
 */
async function makeOuterTransparent(
  input: Buffer,
  whiteThreshold = 245,
  shadowThreshold = 180,
  erodePixels = 0,
): Promise<Buffer> {
  const img = sharp(input).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels !== 4) throw new Error(`expected 4 channels after ensureAlpha, got ${channels}`);

  // Use min(R,G,B) as a single "lightness" proxy — a pixel is part of the white-ish
  // exterior only if all three channels are bright. Coloured pixels (e.g. green icon
  // fill) have at least one low channel and break the flood.
  const lightness = (idx: number): number => {
    const r = data[idx]!, g = data[idx + 1]!, b = data[idx + 2]!;
    return r < g ? (r < b ? r : b) : (g < b ? g : b);
  };

  const visited = new Uint8Array(width * height);
  const stack: number[] = [];
  const seedPixel = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    if (lightness(p * 4) < shadowThreshold) return;
    visited[p] = 1;
    stack.push(p);
  };
  seedPixel(0, 0); seedPixel(width - 1, 0); seedPixel(0, height - 1); seedPixel(width - 1, height - 1);

  const span = whiteThreshold - shadowThreshold;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    const l = lightness(p * 4);
    // α = 0 when l >= whiteThreshold, α = 255 when l <= shadowThreshold,
    // linear in between to soften halos.
    const alpha = l >= whiteThreshold ? 0 : Math.round(((whiteThreshold - l) / span) * 255);
    data[p * 4 + 3] = alpha;
    if (x > 0) seedPixel(x - 1, y);
    if (x < width - 1) seedPixel(x + 1, y);
    if (y > 0) seedPixel(x, y - 1);
    if (y < height - 1) seedPixel(x, y + 1);
  }

  if (erodePixels > 0) erodeAlphaMask(data, width, height, erodePixels);

  return await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * In-place 4-connected binary erosion of the alpha channel by `passes` 1-px steps.
 * Any opaque pixel that touches a transparent pixel (or the image edge) becomes
 * transparent. The dark border that survives the flood-fill is the *first* thing
 * to be eroded outwards, eating the residual anti-aliased halo between the border
 * and the transparent exterior; thicker borders need more passes.
 */
function erodeAlphaMask(data: Buffer, width: number, height: number, passes: number): void {
  const size = width * height;
  let mask = new Uint8Array(size);
  for (let p = 0; p < size; p++) mask[p] = data[p * 4 + 3]! > 0 ? 1 : 0;

  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8Array(size);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (mask[p] === 0) continue;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue;
        if (mask[p - 1] === 0 || mask[p + 1] === 0 || mask[p - width] === 0 || mask[p + width] === 0) continue;
        next[p] = 1;
      }
    }
    mask = next;
  }

  for (let p = 0; p < size; p++) {
    if (mask[p] === 0) data[p * 4 + 3] = 0;
  }
}
