export type Harness = 'claude' | 'codex' | 'gemini' | 'grok' | 'opencode' | 'commandcode';

export const harnesses: { id: Harness; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'grok', label: 'Grok' },
  { id: 'opencode', label: 'opencode' },
  { id: 'commandcode', label: 'Command Code' },
];
