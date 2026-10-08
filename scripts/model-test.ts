#!/usr/bin/env bun
import { parseClaudeModelVersions } from '../apps/server/src/harnesses/claude/adapter.ts'
import type { ModelInfo } from '@shared'
import { parseCommandCodeEffortDocs } from '../apps/server/src/harnesses/commandcode/adapter.ts'
import { effortsForCommandCodeModel } from '../apps/server/src/harnesses/commandcode/efforts.ts'
import { effortCapability, effortsAreKnown, effortsFor, findModelChoice, modelChoices, modelWithEffort, supportedEffort } from '../apps/ui/src/models.ts'

const failures: string[] = []
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const encoded = ['low', 'medium', 'high'].map((effort) => ({
  id: `gpt-5.6-luna[${effort}]`,
  label: `GPT-5.6-Luna (${effort})`,
}))
const choices = modelChoices(encoded)
check('effort variants become one model row', choices.length === 1, choices)
check('the model row does not say low', choices[0]?.label === 'GPT-5.6-Luna', choices[0])
check('the effort picker gets every encoded level', effortsFor(encoded, 'gpt-5.6-luna').join(',') === 'low,medium,high')
check('encoded ACP effort variants make the picker interactive', effortsAreKnown(encoded, 'gpt-5.6-luna'))
check('changing effort rewrites the encoded model id', modelWithEffort(choices[0], 'high') === 'gpt-5.6-luna[high]')

const defaultChoices = modelChoices(encoded.map((model) => ({
  ...model,
  isDefault: model.id.endsWith('[high]'),
})))
check(
  'the resolved default preserves its current encoded effort',
  defaultChoices[0]?.isDefault === true && defaultChoices[0]?.defaultEffort === 'high',
  defaultChoices[0],
)

const fixed = [{ id: 'xiaomi/mimo-v2.6-flash', label: 'MiMo V2.6 Flash', efforts: [] }]
check('an explicit empty effort list stays fixed', effortsFor(fixed, fixed[0]!.id).length === 0)
check('an explicit empty effort list is known but not adjustable', effortsAreKnown(fixed, fixed[0]!.id))
check('a model without effort metadata is not guessed adjustable', !effortsAreKnown([{ id: 'new-model', label: 'New Model' }], 'new-model'))

// Every wired harness feeds the same normalized model contract. These are its
// actual protocol shapes, not a table granting effort by harness name.
const harnessScenarios: Array<{ harness: string; models: ModelInfo[]; base: string; known: boolean; levels: string }> = [
  { harness: 'claude', models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }], base: 'opus', known: true, levels: 'low,high' },
  { harness: 'commandcode', models: [{ id: 'cmd-model', label: 'Command Code Model', efforts: ['medium'] }], base: 'cmd-model', known: true, levels: 'medium' },
  { harness: 'codex', models: encoded, base: 'gpt-5.6-luna', known: true, levels: 'low,medium,high' },
  { harness: 'gemini', models: [{ id: 'gemini-model', label: 'Gemini Model', efforts: ['low', 'high'] }], base: 'gemini-model', known: true, levels: 'low,high' },
  { harness: 'grok', models: [{ id: 'grok-model', label: 'Grok Model' }], base: 'grok-model', known: false, levels: '' },
  { harness: 'opencode', models: [{ id: 'mimo', label: 'MiMo', efforts: [] }], base: 'mimo', known: true, levels: '' },
  { harness: 'freebuff', models: [], base: '', known: false, levels: '' },
]
for (const scenario of harnessScenarios) {
  const capability = effortCapability(scenario.models, scenario.base)
  check(`${scenario.harness} uses its reported effort capability`,
    capability.known === scenario.known && capability.levels.join(',') === scenario.levels &&
    capability.fixed === (scenario.known && !scenario.levels), capability)
}
check('a mixed cached catalog retains encoded effort variants',
  effortCapability([{ id: 'gpt-6-luna', label: 'Luna', efforts: [] },
    { id: 'gpt-6-luna[low]', label: 'Luna Low' }], 'gpt-6-luna').levels.join(',') === 'low')
check('a reported effort survives session launch', supportedEffort(harnessScenarios[0]!.models, 'opus', 'high') === 'high')
check('a reported default-model effort survives session launch',
  supportedEffort([{ id: '', label: 'Default', isDefault: true, efforts: ['low'] }], null, 'low') === 'low')
check('a stale effort from another harness is dropped before launch', supportedEffort(harnessScenarios[0]!.models, 'opus', 'max') === null)
check('an unreported effort is never sent', supportedEffort(harnessScenarios[4]!.models, 'grok-model', 'high') === null)
check('an encoded model id does not also send an explicit effort', supportedEffort(encoded, 'gpt-5.6-luna[low]', 'low') === null)
check('Command Code MiMo never receives an effort', effortsForCommandCodeModel(fixed[0]!.id)?.length === 0)
check('Command Code Luna offers its live levels', effortsForCommandCodeModel('gpt-5.6-luna')?.includes('high') === true)
check('Command Code Opus 5.5 offers its live levels', effortsForCommandCodeModel('claude-opus-5-5')?.includes('xhigh') === true)
check(
  'Command Code effort metadata is read from its installed generated catalog',
  parseCommandCodeEffortDocs('| `future/model-7` | Future 7 | 1M | low, high, max | $1 | Go | test |')
    .get('future/model-7')?.join(',') === 'low,high,max',
)

const claudeAliases = modelChoices([
  { id: 'opus', label: 'Opus 5.5 (latest)', efforts: ['low', 'high'] },
  { id: 'fable', label: 'Fable 5.1 (latest)', efforts: ['low', 'high'] },
])
const millionFirst = modelChoices([
  { id: 'opus[1m]', label: 'Opus 5.5 · 1M (latest)', efforts: ['low', 'high'] },
  { id: 'opus', label: 'Opus 5.5 (latest)', efforts: ['low', 'high'] },
])
check('a resolved Claude id does not imply the 1M variant',
  findModelChoice(millionFirst, 'claude-opus-5-5')?.id === 'opus')
check('an explicit Claude 1M alias keeps its own label',
  findModelChoice(millionFirst, 'opus[1m]')?.id === 'opus[1m]')
check(
  'a resolved Claude id keeps the readable alias and its capabilities',
  findModelChoice(claudeAliases, 'claude-opus-5-5-20260901')?.label === 'Opus 5.5 (latest)',
  claudeAliases,
)
check(
  'concrete Claude versions are learned from the installed binary',
  JSON.stringify(parseClaudeModelVersions('claude-opus-5-0 claude-opus-5-5 claude-fable-5-1 claude-haiku-4-5-20251001')) ===
    JSON.stringify({ opus: '5.5', fable: '5.1', haiku: '4.5' }),
)

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
console.log('model-test: PASSED (28 checks)')
