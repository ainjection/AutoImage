export interface Subject {
  description: string;
  action: string;
}

export interface ImagePrompt {
  subjects: Subject[];
  environment: string;
  lighting: string;
  composition: string;
  style: string;
}

export interface ScriptScene {
  scene_number: number;
  image_prompt?: ImagePrompt; // for image mode
  prompt?: string;            // for video mode (plain text shot/story beat)
  narration?: string;
}

export type GenMode = 'image' | 'video';

export interface ScriptData {
  scenes: ScriptScene[];
}

export type QueueStatus = 'PENDING' | 'IN_PROGRESS' | 'READY' | 'DOWNLOADED' | 'RATE_LIMITED' | 'ERROR';

export interface QueueItem {
  id: string;
  scene_number: number;
  prompt: string;
  status: QueueStatus;
  project: string;
  mode: GenMode;
}
