/**
 * Model metadata re-exported from @contextio/core.
 *
 * Context-lens inherits pricing, context limits, and cost estimation
 * from the shared contextio package. This file is the single import
 * point so the rest of the codebase doesn't import from @contextio/core
 * directly.
 */

export {
  CONTEXT_LIMITS,
  estimateCost,
  getContextLimit,
  getKnownModels,
  MODEL_PRICING,
} from "@contextio/core";

/**
 * Normalize a Bedrock model ID to its standard Anthropic form.
 *
 * Strips region prefix (e.g. "us."), vendor prefix ("anthropic."),
 * and version suffix (e.g. "-v1:0", "-v2:0").
 *
 * If the ID does not contain "anthropic." it is returned unchanged,
 * so standard Anthropic model IDs pass through safely.
 */
export function normalizeBedrockModelId(modelId: string): string {
  if (!modelId.includes("anthropic.")) return modelId;
  return modelId
    .replace(/^[a-z]{2}\./, "")
    .replace(/^anthropic\./, "")
    .replace(/-v\d+:\d+$/, "");
}
