import type { ChatMessage, ToolCall, ToolSpec, VeniceClient } from '@stare/llm';
import type { ChatModel } from './agent.ts';

/** The agents' model on Venice (tool calling). */
export class VeniceChatModel implements ChatModel {
  constructor(
    private client: VeniceClient,
    readonly model: string,
  ) {}
  async chat(messages: ChatMessage[], tools: ToolSpec[]) {
    const r = await this.client.chat(messages, {
      model: this.model,
      tools,
      maxTokens: 700,
      temperature: 0,
      timeoutMs: 45_000,
    });
    return { content: r.content, toolCalls: r.toolCalls };
  }
}

/**
 * A scripted agent model for tests and offline demos: recall → file_exception → remember → reply.
 * It exercises the same MCP calls a model would make, deterministically.
 */
export class ScriptedChatModel implements ChatModel {
  readonly model = 'scripted';
  async chat(messages: ChatMessage[]): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
    const request = messages.find((m) => m.role === 'user')?.content ?? '';
    const done = messages.filter((m) => m.role === 'tool').map((m) => m.name);
    const call = (name: string, args: Record<string, unknown>): ToolCall => ({
      id: `c${done.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    const account = request
      .match(/^\s*((?:[A-Z][\w&'.-]*\s?){1,4})/)?.[1]
      ?.trim()
      .replace(/\s+(is|wants|has|will|needs|procurement)$/i, '');
    if (!done.includes('recall'))
      return { content: null, toolCalls: [call('recall', { query: request.slice(0, 200), account })] };
    if (!done.includes('file_exception'))
      return { content: null, toolCalls: [call('file_exception', { request })] };
    const result =
      [...messages].reverse().find((m) => m.role === 'tool' && m.name === 'file_exception')?.content ?? '';
    if (!done.includes('remember'))
      return { content: null, toolCalls: [call('remember', { summary: result.slice(0, 300) })] };
    return { content: result.split('. ')[0] ?? result, toolCalls: [] };
  }
}
