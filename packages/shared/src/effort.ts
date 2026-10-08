import type { EffortLevel, HarnessId } from './events.ts'

/**
 * Which reasoning efforts a model actually honours.
 *
 * Offering all five levels everywhere was a lie: the ACP harnesses ignore
 * effort entirely (the driver never sends it), and Haiku has no adjustable
 * reasoning at all. An empty list means "this harness/model has no effort
 * knob", and the composer hides the picker instead of pretending.
 */
const ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function effortsFor(harness: HarnessId, model: string | null): EffortLevel[] {
  const id = (model ?? '').toLowerCase()

  switch (harness) {
    // `--effort` is a real flag, but Haiku has no reasoning to adjust: the CLI
    // takes the value and drops it.
    case 'claude':
      return id.includes('haiku') ? [] : ALL

    // Command Code's own help says the flag "depends on the model"; the driver
    // learns the refusals at runtime, so here we only rule out what we know.
    case 'commandcode':
      if (!id) return ALL
      if (id.includes('haiku')) return []
      if (id.startsWith('gpt-') || id.includes('/gpt-')) return ['low', 'medium', 'high']
      return ALL

    // ACP carries no effort field: sending one would change nothing.
    default:
      return []
  }
}
