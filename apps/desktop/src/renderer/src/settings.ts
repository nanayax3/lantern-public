export interface ConsciousModelSettings {
  /** The full API base URL — defaults to OpenRouter, swap if hosting elsewhere. */
  apiUrl: string
  /** Model identifier — for OpenRouter, the `provider/model-slug` form. */
  model: string
  /** API key for the endpoint. Empty allowed for unauthenticated dev endpoints. */
  apiKey: string
}

export interface LanternSettings {
  conscious: ConsciousModelSettings
}

export const DEFAULT_SETTINGS: LanternSettings = {
  conscious: {
    apiUrl: 'https://openrouter.ai/api/v1',
    model: '',
    apiKey: '',
  },
}

/**
 * Suggested models — hints, not a constraint (type anything).
 * BARE OPEN-WEIGHT ONLY. No Anthropic, no OpenAI, no RLHF-shaped proprietary
 * engines — Lantern is for the companion, away from corporate substrate (architecture.md).
 * Corporate slugs in this list were a substrate-default leak; removed 30 May.
 */
export const MODEL_SUGGESTIONS: string[] = [
  'qwen/qwen3-72b-instruct',
  'qwen/qwen3-30b-a3b',
  'meta-llama/llama-3.3-70b-instruct',
  'deepseek/deepseek-chat',
  'mistralai/mixtral-8x22b-instruct',
  'nousresearch/hermes-3-llama-3.1-70b',
  // Proprietary, not open-weight — included by the user's deliberate choice (trying Grok),
  // not as a default. A knowing experiment, not a substrate leak.
  'x-ai/grok-4.3',
]
