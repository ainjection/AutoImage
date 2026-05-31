import { ImagePrompt } from './types';

// Flatten a structured image_prompt into a single text prompt for Flow.
export function parseImagePromptToText(prompt: ImagePrompt): string {
  const subjects = prompt.subjects
    .map(s => `${s.description} ${s.action}`.trim())
    .join(', ');

  return [
    `Subjects: ${subjects}.`,
    `Environment: ${prompt.environment}`,
    `Lighting: ${prompt.lighting}`,
    `Composition: ${prompt.composition}`,
    `Style: ${prompt.style}`,
  ].join('\n').trim();
}
