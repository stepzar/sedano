/**
 * Whether a model can see an image.
 *
 * The harness is not the thing that decides this. Command Code with a Claude or
 * a Gemini model reads a screenshot; the same harness on a text-only model does
 * not — one flag per harness was wrong in both directions, promising what a
 * model cannot do and refusing what it can. The answer belongs to the model, and
 * it is assembled here from what the harness says about itself:
 *
 *  1. The catalog entry. Command Code describes every model it offers and its
 *     descriptions say "with vision", "multimodal", "vision-language" where that
 *     applies, which is the part that stays current without a new build of ours.
 *  2. The families whose support is a fact of the model rather than of one
 *     catalog entry. Anthropic, OpenAI and Google list their models without ever
 *     saying they can see, and every model they ship now does.
 *  3. Command Code's own list of models it knows to be text-only. Its CLI keeps
 *     that list to answer exactly this question, so it is mirrored here instead
 *     of guessed at.
 *
 * `undefined` is a real answer — "nobody said" — and the caller then falls back
 * to what the harness claims about the whole harness.
 */

/** How a catalog words it when the model takes images. */
const VISION_WORDS = /(vision|multimodal|multi-modal|omni-modal|vision-language)/i

/**
 * Families whose image support is a documented fact of the model. The first
 * match wins, so the specific cases come before the general ones.
 *
 * The negative entries exist so an unnamed variant is not promised a capability
 * it does not have — a catalog that knows better still wins, because the wording
 * check above runs first.
 */
const FAMILIES: Array<[RegExp, boolean]> = [
  // Every Claude from 3 on takes images, and Claude Code's own aliases are all
  // current models.
  [/claude|^(opus|sonnet|haiku|fable)/i, true],
  // Gemini has been multimodal since 1.5.
  [/gemini/i, true],
  // OpenAI: 4o, 4.1, 4.5, the 5 and 6 lines, and the o-series see; the original
  // GPT-4 and 3.5 do not.
  [/gpt-4o|gpt-4\.1|gpt-4\.5|gpt-[5-9]|\bo[34](-|$)/i, true],
  [/gpt-3\.5|gpt-4(\b|$)/i, false],
  // xAI: images from grok-4 on (`-vision` builds are caught by the wording).
  [/grok-[4-9]/i, true],
  [/grok/i, false],
  // Families that are text-only by construction. A vision variant spells it out
  // — `-vl`, `v`, `omni`, "with vision" — and the wording check above reads it.
  [/deepseek|glm|qwen|kimi|moonshot|minimax|mimo|longcat|step-\d|hunyuan|\bhy\d|nemotron|laguna|ling-|sakana/i, false],
]

/**
 * The models Command Code itself calls text-only (its `--list-models` says which
 * one with vision). Mirrored from that CLI's own catalog, lowercased: a release
 * that adds a vision model says so in its description, so this list only has to
 * be right about what it names, and being stale is safe.
 */
const COMMAND_CODE_TEXT_ONLY = new Set(
  [
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-v4-flash-fast',
    'zai-org/glm-5.3',
    'zai-org/glm-5.2',
    'zai-org/glm-5.2-fast',
    'zai-org/glm-5.1',
    'zai-org/glm-5',
    'minimaxai/minimax-m2.7',
    'minimax/minimax-m2.7-free',
    'minimaxai/minimax-m2.5',
    'xiaomi/mimo-v2.5-pro',
    'qwen/qwen3.6-max-preview',
    'qwen/qwen3.7-max',
    'meituan/longcat-2.0',
    'meituan/longcat-2.0:free',
    'stepfun/step-3.5-flash',
    'tencent/hy4-preview',
    'tencent/hy3',
    'tencent/hy3-paid',
    'nvidia/nemotron-3-ultra-550b-a55b',
    'poolside/laguna-s-2.1-free',
    'inclusionai/ling-3.0-flash-free',
    'inclusionai/ling-3.0-flash-sante:free',
  ].map((id) => id.toLowerCase()),
)

/** True when the wording or the id names the capability. */
function saysVision(id: string, wording: string): boolean {
  if (VISION_WORDS.test(`${id} ${wording}`)) return true
  // The id conventions: `-vl`, `-vision`, `omni`, and the `…v` suffix every
  // catalog uses for its vision build (`glm-4.6v`, `qwen2.5-vl`).
  return /[-_/]vl[-_/]?\b|[-_/]vision\b|\bvision[-_]|omni|\d+v\b/i.test(id)
}

/**
 * Whether this model takes image input. `undefined` means nobody said, and the
 * harness's own answer is then the one that counts.
 */
export function modelTakesImages(id: string, wording = ''): boolean | undefined {
  if (!id) return undefined
  if (saysVision(id, wording)) return true
  if (COMMAND_CODE_TEXT_ONLY.has(id.toLowerCase())) return false
  for (const [pattern, takes] of FAMILIES) {
    if (pattern.test(id)) return takes
  }
  return undefined
}

/** The same answer, attached to a model entry the way every list wants it. */
export function withImageSupport<T extends { id: string; label?: string }>(model: T): T & { images?: boolean } {
  const images = modelTakesImages(model.id, model.label ?? '')
  return images === undefined ? model : { ...model, images }
}
