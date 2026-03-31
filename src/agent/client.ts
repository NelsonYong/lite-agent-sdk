import Anthropic from "@anthropic-ai/sdk";

let anthropic: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic({
      apiKey: process.env["ANTHROPIC_API_KEY"],
      baseURL: process.env["ANTHROPIC_BASE_URL"],
    });
  }
  return anthropic;
}