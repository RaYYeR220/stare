import { describe, expect, it } from 'vitest';
import { ROSTER, routeTo } from '../src/agent.ts';
import { ScriptedChatModel } from '../src/models.ts';

describe('agents', () => {
  it('routes by channel and by what is asked', () => {
    expect(routeTo('#deal-desk', 'x')).toBe('a-renewals');
    expect(routeTo('#billing-ops', 'x')).toBe('a-billing');
    expect(routeTo('#support-escalations', 'Acme wants Net-60')).toBe('a-billing');
    expect(routeTo('#support-escalations', 'refund $300')).toBe('a-support');
  });

  it('the scripted model walks recall → file_exception → remember → reply', async () => {
    const m = new ScriptedChatModel();
    const msgs: any[] = [
      { role: 'system', content: ROSTER['a-support'].system },
      { role: 'user', content: 'Acme Logistics wants $500 back.' },
    ];
    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await m.chat(msgs);
      if (!r.toolCalls.length) break;
      names.push(r.toolCalls[0]!.function.name);
      msgs.push({ role: 'assistant', content: null, tool_calls: r.toolCalls });
      msgs.push({
        role: 'tool',
        name: r.toolCalls[0]!.function.name,
        tool_call_id: r.toolCalls[0]!.id,
        content: 'APPROVED $500 — Acme Logistics. ok',
      });
    }
    expect(names).toEqual(['recall', 'file_exception', 'remember']);
  });
});
