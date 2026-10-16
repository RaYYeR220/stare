/** Minimal client for the Venice API (chat completions with JSON-schema output and tool calls; embeddings). */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  schema?: { name: string; schema: Record<string, unknown> };
  tools?: ToolSpec[];
  timeoutMs?: number;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { prompt: number; completion: number };
  model: string;
}

export class VeniceClient {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.venice.ai/api/v1',
  ) {
    if (!apiKey) throw new Error('VENICE_API_KEY is not set');
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          last = new Error(`Venice ${res.status}: ${(await res.text()).slice(0, 200)}`);
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        if (!res.ok) {
          const text = await res.text();
          // Some models only run with reasoning on; retry the same request without disabling it.
          if (res.status === 400 && /thinking-only/i.test(text) && (body as { venice_parameters?: Record<string, unknown> }).venice_parameters?.disable_thinking) {
            (body as { venice_parameters: Record<string, unknown> }).venice_parameters.disable_thinking = false;
            continue;
          }
          throw new Error(`Venice ${res.status}: ${text.slice(0, 300)}`);
        }
        return (await res.json()) as T;
      } catch (e) {
        last = e;
        if ((e as Error).name !== 'AbortError' && !String(e).includes('fetch failed')) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw last;
  }

  async chat(messages: ChatMessage[], o: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: o.model,
      messages,
      temperature: o.temperature ?? 0,
      max_completion_tokens: o.maxTokens ?? 800,
      venice_parameters: { include_venice_system_prompt: false, disable_thinking: true, strip_thinking_response: true },
    };
    if (o.schema) body.response_format = { type: 'json_schema', json_schema: { name: o.schema.name, strict: true, schema: o.schema.schema } };
    if (o.tools?.length) {
      body.tools = o.tools;
      body.tool_choice = 'auto';
    }
    const r = await this.post<{
      model: string;
      choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    }>('/chat/completions', body, o.timeoutMs);
    const m = r.choices[0]?.message;
    return {
      content: m?.content ?? null,
      toolCalls: m?.tool_calls ?? [],
      usage: { prompt: r.usage?.prompt_tokens ?? 0, completion: r.usage?.completion_tokens ?? 0 },
      model: r.model,
    };
  }

  async embed(texts: string[], model: string, dimensions?: number): Promise<number[][]> {
    const r = await this.post<{ data: { embedding: number[]; index: number }[] }>('/embeddings', {
      model,
      input: texts,
      encoding_format: 'float',
      ...(dimensions ? { dimensions } : {}),
    });
    return r.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
