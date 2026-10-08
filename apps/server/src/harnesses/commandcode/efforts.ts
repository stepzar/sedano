/**
 * Which reasoning efforts each of Command Code's models accepts.
 *
 * Its CLI keeps this table for itself (`getSupportedEfforts` in its own bundle)
 * and *rejects the whole run* when it is sent something else: `--effort medium`
 * for a model that only knows `low, high, max` exits before doing any work, which
 * is how a picker offering the wrong level breaks a turn. Mirrored here, so the
 * picker can offer exactly what the CLI takes and the driver never guesses.
 *
 * An empty list means the model has no adjustable effort at all; a model that is
 * missing from this table is one this build does not know about, and the answer
 * the CLI gives when it refuses is remembered (see the driver).
 */
export const COMMAND_CODE_EFFORTS: Record<string, string[]> = {
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "deepseek/deepseek-v4-flash": ["high", "max"],
  "deepseek/deepseek-v4-flash-vision-exp": ["high", "max"],
  "deepseek/deepseek-v4-flash-fast": ["low", "high", "max"],
  "deepseek/deepseek-v4.1-flash": ["low", "high", "max"],
  "moonshotai/Kimi-K3": ["low", "high", "max"],
  "zai-org/GLM-5.3": ["low", "high", "max"],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  "z-ai/glm-5.3-flashx": ["low", "high", "max"],
  "zai-org/GLM-5.2": ["high", "max"],
  "google/gemini-3.8-flash": ["low", "medium", "high"],
  "google/gemini-3.7-flash": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "tencent/hy4-preview": ["low", "medium", "high"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.1": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2-contributor": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.3-contributor": ["low", "medium", "high", "xhigh"],
  "MiniMaxAI/MiniMax-M3": ["low", "medium", "high"],
  "minimax/minimax-m3-free": ["low", "medium", "high"],
  "claude-haiku-4-5-20251001": [],
  "MiniMaxAI/MiniMax-M3-Free": [],
  "moonshotai/Kimi-K2.7-Code": [],
  "moonshotai/Kimi-K2.7-Code-Highspeed": [],
  "moonshotai/Kimi-K2.6": [],
  "moonshotai/Kimi-K2.5": [],
  "zai-org/GLM-5.2-Fast": [],
  "zai-org/GLM-5": [],
  "minimax/minimax-m2.7-free": [],
  "MiniMaxAI/MiniMax-M2.5": [],
  "xiaomi/mimo-v2.5-pro": [],
  "xiaomi/mimo-v2.5": [],
  "xiaomi/mimo-v2.6-pro": [],
  "xiaomi/mimo-v2.6-pro-ultraspeed": [],
  "xiaomi/mimo-v2.6-flash": [],
  "Qwen/Qwen3.7-Max": [],
  "Qwen/Qwen3.7-Plus": [],
  "Qwen/Qwen3.8-Omni-Flash": [],
  "Qwen/Qwen3.8-Max-0902": [],
  "Qwen/Qwen3.8-Max": [],
  "Qwen/Qwen3.8-27B": [],
  "Qwen/Qwen3.8-Flash": [],
  "Qwen/Qwen3.7-Flash": [],
  "meituan/LongCat-2.0": [],
  "meituan/LongCat-2.0:free": [],
  "stepfun/Step-3.7-Flash": [],
  "stepfun/Step-3.5-Flash": [],
  "tencent/hy3-paid": [],
  "tencent/Hy3": [],
  "thinkingmachines/inkling": [],
  "thinkingmachines/inkling-small": [],
  "poolside/laguna-s-2.1-free": [],
  "inclusionai/ling-3.0-flash-free": [],
  "inclusionai/ling-3.0-flash-sante:free": [],
  "sakana/fugu-ultra": [],
  "nvidia/nemotron-3-ultra-550b-a55b": [],
}

/**
 * What the CLI itself said, when it refused an effort: it names the ones it
 * takes ("Supported: low, high, max"), which is a better answer than this table
 * for a model newer than this build.
 */
const learned = new Map<string, string[]>()

export function rememberCommandCodeEfforts(model: string, efforts: string[]): void {
  if (efforts.length) learned.set(model.toLowerCase(), efforts)
}

/** The efforts for a model: what the CLI told us first, then the table. */
export function effortsForCommandCodeModel(model: string | null): string[] | null {
  if (!model) return null
  const wanted = model.toLowerCase()
  const told = learned.get(wanted)
  if (told) return told
  for (const [id, efforts] of Object.entries(COMMAND_CODE_EFFORTS)) {
    if (id.toLowerCase() === wanted) return efforts
  }
  return null
}
