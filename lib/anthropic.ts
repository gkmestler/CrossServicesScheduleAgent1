import Anthropic from "@anthropic-ai/sdk";

/**
 * Server-only Anthropic client. `ANTHROPIC_API_KEY` is never exposed to the
 * browser — every call to this module happens inside a route handler.
 */

/**
 * The build spec names claude-opus-4-8. Claude Opus 5 (`claude-opus-5`) is
 * available at the same price and is a drop-in upgrade, so this is overridable
 * without a redeploy of anything but an env var.
 */
export const PARSING_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

let client: Anthropic | null = null;

export function isClaudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function getClaude(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (!client) {
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Two calls per Saturday; a slow one is far better than a failed one.
      maxRetries: 2,
      timeout: 5 * 60 * 1000,
    });
  }
  return client;
}
