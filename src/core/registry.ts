export type ModelDestDir =
  | 'diffusion_models'
  | 'text_encoders'
  | 'unet'
  | 'checkpoints'
  | 'loras'
  | 'vae'
  | 'clip'
  | 'background_removal';

export type ModelSource = 'huggingface' | 'civitai' | 'local';

export interface ModelEntry {
  id: string;
  displayName: string;
  description: string;
  destDir: ModelDestDir;
  filename: string;
  sizeBytes: number;
  url: string;
  sha256?: string;
  source: ModelSource;
  requiresApiKey?: boolean;
  recommendedFor?: string[];
  /** If true, the user likely already has this — installer should skip and just confirm presence. */
  expectedPresent?: boolean;
}

export const MODEL_REGISTRY: ModelEntry[] = [
  {
    id: 'zimage-turbo',
    displayName: 'Z-Image Turbo (bf16)',
    description: 'Alibaba/Tongyi 6B turbo diffusion model. ~6GB VRAM, sub-second 1024x1024 in 8 steps. Excellent text rendering.',
    destDir: 'diffusion_models',
    filename: 'z_image_turbo_bf16.safetensors',
    sizeBytes: 12_000_000_000,
    url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors',
    source: 'huggingface',
    recommendedFor: ['icons', 'logos', 'text', 'fast'],
  },
  {
    id: 'qwen3-4b-encoder',
    displayName: 'Qwen3-4B text encoder',
    description: 'Text encoder required by Z-Image Turbo (CLIPLoader type: lumina2).',
    destDir: 'text_encoders',
    filename: 'qwen_3_4b.safetensors',
    sizeBytes: 8_000_000_000,
    url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
    source: 'huggingface',
    recommendedFor: ['zimage'],
  },
  {
    id: 'zimage-vae',
    displayName: 'Z-Image VAE (ae.safetensors)',
    description: 'VAE required by Z-Image Turbo.',
    destDir: 'vae',
    filename: 'ae.safetensors',
    sizeBytes: 335_000_000,
    url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors',
    source: 'huggingface',
    recommendedFor: ['zimage'],
  },
  {
    id: 'flux-schnell-fp8',
    displayName: 'Flux Schnell fp8',
    description: 'Black Forest Labs Flux Schnell, fp8 quantized. 4-step turbo model.',
    destDir: 'unet',
    filename: 'flux1-schnell-fp8.safetensors',
    sizeBytes: 17_000_000_000,
    url: 'https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors',
    source: 'huggingface',
    expectedPresent: true,
    recommendedFor: ['quality', 'photoreal'],
  },
  {
    id: 'dreamshaper-xl-turbo',
    displayName: 'DreamShaper XL Turbo',
    description: 'SDXL Turbo fine-tune, fast generation in 4-8 steps.',
    destDir: 'checkpoints',
    filename: 'dreamshaperXL_v21TurboDPMSDE.safetensors',
    sizeBytes: 6_500_000_000,
    url: 'https://civitai.com/api/download/models/351306',
    source: 'civitai',
    expectedPresent: true,
    recommendedFor: ['general', 'fast'],
  },
  {
    id: 'sdxl-base',
    displayName: 'SDXL Base 1.0 (VAE fix)',
    description: 'Standard SDXL base 1.0 checkpoint.',
    destDir: 'checkpoints',
    filename: 'sdXL_v10VAEFix.safetensors',
    sizeBytes: 6_500_000_000,
    url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors',
    source: 'huggingface',
    expectedPresent: true,
    recommendedFor: ['general'],
  },
  {
    id: 'clip-l',
    displayName: 'CLIP-L text encoder',
    description: 'CLIP-L encoder used by Flux and SDXL.',
    destDir: 'clip',
    filename: 'clip_l.safetensors',
    sizeBytes: 246_000_000,
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',
    source: 'huggingface',
    expectedPresent: true,
  },
  {
    id: 't5xxl-fp8',
    displayName: 'T5-XXL fp8 text encoder',
    description: 'T5-XXL fp8 encoder used by Flux.',
    destDir: 'clip',
    filename: 't5xxl_fp8_e4m3fn.safetensors',
    sizeBytes: 4_900_000_000,
    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors',
    source: 'huggingface',
    expectedPresent: true,
  },
  {
    id: 'flux-vae',
    displayName: 'Flux VAE',
    description: 'VAE for Flux models.',
    destDir: 'vae',
    filename: 'flux_vae.safetensors',
    sizeBytes: 335_000_000,
    url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors',
    source: 'huggingface',
    expectedPresent: true,
  },
  {
    id: 'sdxl-vae',
    displayName: 'SDXL VAE',
    description: 'Standard VAE for SDXL models.',
    destDir: 'vae',
    filename: 'sdxl_vae.safetensors',
    sizeBytes: 335_000_000,
    url: 'https://huggingface.co/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors',
    source: 'huggingface',
    expectedPresent: true,
  },
  {
    id: 'birefnet-bg-removal',
    displayName: 'BiRefNet (background removal)',
    description: 'High-quality alpha matting model for transparent background extraction. ComfyUI-Org build that the `LoadBackgroundRemovalModel` node recognises out of the box.',
    destDir: 'background_removal',
    filename: 'birefnet.safetensors',
    sizeBytes: 444_000_000,
    url: 'https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors',
    source: 'huggingface',
    recommendedFor: ['transparent', 'logos'],
  },
];

/** Quick lookup helpers. */
export function findModel(id: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

export function modelsForUseCase(useCase: string): ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.recommendedFor?.includes(useCase));
}

/** Model IDs the wizard pre-selects by default (those that are not expectedPresent). */
export const DEFAULT_INSTALL_IDS = [
  'zimage-turbo',
  'qwen3-4b-encoder',
  'zimage-vae',
  'birefnet-bg-removal',
];
