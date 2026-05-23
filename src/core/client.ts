import { randomUUID } from 'node:crypto';
import { request } from 'undici';
import WebSocket from 'ws';

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: 'output' | 'temp' | 'input';
}

export interface SystemStats {
  system?: unknown;
  devices?: Array<{ name: string; vram_total: number; vram_free: number }>;
}

export interface QueueResponse {
  prompt_id: string;
  number: number;
  node_errors?: Record<string, unknown>;
}

export interface ProgressEvent {
  type: 'progress';
  value: number;
  max: number;
  promptId: string;
}

export interface ExecutingEvent {
  type: 'executing';
  /** Node currently executing. null means the prompt finished. */
  node: string | null;
  promptId: string;
}

export interface ExecutedEvent {
  type: 'executed';
  node: string;
  images: ComfyImageRef[];
  promptId: string;
}

export interface ExecutionErrorEvent {
  type: 'execution_error';
  message: string;
  promptId: string;
}

export type ComfyEvent =
  | ProgressEvent
  | ExecutingEvent
  | ExecutedEvent
  | ExecutionErrorEvent;

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export class ComfyClient {
  readonly clientId: string;
  private readonly baseUrl: string;

  constructor(baseUrl: string, clientId?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.clientId = clientId ?? randomUUID();
  }

  async systemStats(): Promise<SystemStats> {
    const { body, statusCode } = await request(`${this.baseUrl}/system_stats`);
    if (statusCode >= 400) throw new Error(`ComfyUI /system_stats returned ${statusCode}`);
    return (await body.json()) as SystemStats;
  }

  async ping(): Promise<boolean> {
    try {
      await this.systemStats();
      return true;
    } catch {
      return false;
    }
  }

  async queuePrompt(workflow: Workflow): Promise<QueueResponse> {
    const { body, statusCode } = await request(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    if (statusCode >= 400) {
      const text = await body.text();
      throw new Error(`ComfyUI /prompt returned ${statusCode}: ${text}`);
    }
    const data = (await body.json()) as QueueResponse;
    if (data.node_errors && Object.keys(data.node_errors).length > 0) {
      throw new Error(`ComfyUI prompt had node errors: ${JSON.stringify(data.node_errors)}`);
    }
    return data;
  }

  /**
   * Subscribe to ComfyUI websocket and yield events until either the given
   * prompt finishes (`executing` with null node) or an error is reported.
   */
  async *streamEvents(promptId: string, opts: { timeoutMs?: number } = {}): AsyncGenerator<ComfyEvent> {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/ws?clientId=${this.clientId}`;
    const ws = new WebSocket(wsUrl);
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

    const pending: ComfyEvent[] = [];
    let resolveNext: ((v: ComfyEvent | null) => void) | null = null;
    let closed = false;
    let error: Error | null = null;

    const push = (ev: ComfyEvent | null) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(ev);
      } else if (ev) {
        pending.push(ev);
      }
    };

    ws.on('open', () => { /* connected */ });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg: { type: string; data: Record<string, unknown> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'progress': {
          const d = msg.data as { value: number; max: number; prompt_id?: string };
          push({ type: 'progress', value: d.value, max: d.max, promptId: d.prompt_id ?? promptId });
          break;
        }
        case 'executing': {
          const d = msg.data as { node: string | null; prompt_id?: string };
          if (d.prompt_id && d.prompt_id !== promptId) break;
          push({ type: 'executing', node: d.node, promptId: d.prompt_id ?? promptId });
          if (d.node === null) {
            closed = true;
            push(null);
            ws.close();
          }
          break;
        }
        case 'executed': {
          const d = msg.data as {
            node: string;
            output?: { images?: ComfyImageRef[] };
            prompt_id?: string;
          };
          if (d.prompt_id && d.prompt_id !== promptId) break;
          const images = d.output?.images ?? [];
          push({ type: 'executed', node: d.node, images, promptId: d.prompt_id ?? promptId });
          break;
        }
        case 'execution_error': {
          const d = msg.data as { exception_message?: string; prompt_id?: string };
          if (d.prompt_id && d.prompt_id !== promptId) break;
          error = new Error(d.exception_message ?? 'ComfyUI execution error');
          push({
            type: 'execution_error',
            message: d.exception_message ?? 'unknown',
            promptId: d.prompt_id ?? promptId,
          });
          closed = true;
          push(null);
          ws.close();
          break;
        }
        default:
          break;
      }
    });
    ws.on('error', (err) => {
      error = err as Error;
      closed = true;
      push(null);
    });
    ws.on('close', () => {
      closed = true;
      push(null);
    });

    const timer = setTimeout(() => {
      error = new Error(`ComfyUI websocket timed out after ${timeoutMs}ms`);
      closed = true;
      try { ws.close(); } catch { /* noop */ }
      push(null);
    }, timeoutMs);

    try {
      while (true) {
        if (pending.length > 0) {
          yield pending.shift()!;
          continue;
        }
        if (closed) break;
        const ev = await new Promise<ComfyEvent | null>((resolve) => {
          resolveNext = resolve;
        });
        if (ev === null) break;
        yield ev;
      }
      if (error) throw error;
    } finally {
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
    }
  }

  /** Download a generated image as a Buffer via /view. */
  async fetchImage(ref: ComfyImageRef): Promise<Buffer> {
    const url = `${this.baseUrl}/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder)}&type=${ref.type}`;
    const { body, statusCode } = await request(url);
    if (statusCode >= 400) throw new Error(`ComfyUI /view returned ${statusCode} for ${ref.filename}`);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
}
