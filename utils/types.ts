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
  start_frame?: string;       // video Frames mode: match text for the START frame in Flow's media picker
  end_frame?: string;         // video Frames mode: match text for the END frame in Flow's media picker
  character?: string;         // name of a saved Flow Character to attach (picker -> Characters tab)
}

export type GenMode = 'image' | 'video' | 'whisk';

export interface FlowSettings {
  mode?: 'image' | 'video';            // Image / Video tab
  video_mode?: 'frames' | 'ingredients';
  model?: string;                       // e.g. "Veo 3.1 - Fast", "Omni Flash", "Nano Banana 2"
  duration?: 4 | 6 | 8 | 10;            // video seconds
  aspect?: string;                      // "16:9" | "9:16" | "1:1" | "4:3" | "3:4"
  count?: 1 | 2 | 3 | 4;                // outputs per prompt
}

export interface ScriptData {
  scenes: ScriptScene[];
  settings?: FlowSettings;              // applied to Flow's prompt bar before the first scene
}

export type QueueStatus = 'PENDING' | 'IN_PROGRESS' | 'READY' | 'DOWNLOADED' | 'GENERATED' | 'RATE_LIMITED' | 'ERROR';

export interface QueueItem {
  id: string;
  scene_number: number;
  prompt: string;
  status: QueueStatus;
  project: string;
  mode: GenMode;
  start_frame?: string;
  end_frame?: string;
  character?: string;
}
