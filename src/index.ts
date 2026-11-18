import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ClaudeNativeModel, type Settings } from "./model.js"

export function createClaudeNative(settings: Settings = {}) {
  const make = (id: string): LanguageModelV3 => new ClaudeNativeModel(id, "claude-native", settings)
  const p = ((id: string) => make(id)) as any
  p.languageModel = make
  return p as { (id: string): LanguageModelV3; languageModel(id: string): LanguageModelV3 }
}
export { createClaudeNative as createClaudeCode }
