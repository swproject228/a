
export interface NudityLevel {
  name: string;
  description: string;
  safety: string;
  color: string;
}

export interface Outfit {
  name: string;
  prompt: string;
  preview: string;
  protection: string;
}

export interface Pose {
  name: string;
  prompt: string;
  preview: string;
}

export interface ScenarioStep {
  level: number;
  outfit: number;
  delay: number;
  context?: string;
  extraProtection?: boolean;
}

export interface AutoScenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
  safety: string;
}

export interface TransformationMode {
  name: string;
  description: string;
  icon: string;
  consistency: 'maximum' | 'high' | 'medium' | 'low';
}

export interface Theme {
  name: string;
  bg: string;
  cardBg: string;
  cardBgSecondary: string;
  text: string;
  textSecondary: string;
  accent: string;
  accentSecondary: string;
  border: string;
}

export interface TransformationHistoryItem {
  level: number;
  image: string;
  prompt: string;
  timestamp: number;
  success: boolean;
}

export interface FavoriteItem {
  image: string;
  timestamp: number;
  id: number;
}

export interface PromptHistoryItem {
  prompt: string;
  timestamp: number;
  id: number;
}

export interface ProgressLogItem {
  message: string;
  timestamp: number;
}

export interface AppState {
  originalImage: string | null;
  originalImageMimeType: string | null;
  currentLevel: number;
  transformationHistory: TransformationHistoryItem[];
  results: (string | null)[];
  loadingStates: boolean[];
  errors: (string | null)[];
  autoMode: boolean;
  selectedScenario: string | null;
  autoRunning: boolean;
  currentStep: number;
  successRate: { successful: number; failed: number; blocked: number; };
  retryAttempts: number[];
  lockSeed: boolean;
  currentSeed: number | null;
  progressLog: ProgressLogItem[];
  sessionStarted: number | null;
  transformMode: 'CLOTHING' | 'POSE' | 'FREE' | 'BALANCED';
  selectedPose: Pose | null;
  favorites: FavoriteItem[];
  qualitySettings: { steps: number; guidanceScale: number; strength: number; };
  promptHistory: PromptHistoryItem[];
  currentTheme: 'dark' | 'midnight' | 'purple' | 'ocean';
  showQualitySettings: boolean;
  showPoseLibrary: boolean;
}

export type AppAction =
  | { type: 'SET_ORIGINAL_IMAGE'; payload: { image: string; mimeType: string; } }
  | { type: 'SET_LEVEL'; payload: number }
  | { type: 'ADD_TO_HISTORY'; payload: TransformationHistoryItem }
  | { type: 'SET_RESULT'; payload: { index: number; result: string | null } }
  | { type: 'SET_LOADING'; payload: { index: number; isLoading: boolean } }
  | { type: 'SET_ERROR'; payload: { index: number; error: string | null } }
  | { type: 'INCREMENT_RETRY'; payload: number }
  | { type: 'UPDATE_SUCCESS_RATE'; payload: { success: boolean; blocked?: boolean } }
  | { type: 'ADD_LOG'; payload: string }
  | { type: 'SET_AUTO_MODE'; payload: boolean }
  | { type: 'SET_SCENARIO'; payload: string | null }
  | { type: 'SET_AUTO_RUNNING'; payload: boolean }
  | { type: 'SET_CURRENT_STEP'; payload: number }
  | { type: 'SET_SEED'; payload: number | null }
  | { type: 'TOGGLE_LOCK_SEED' }
  | { type: 'SET_TRANSFORM_MODE'; payload: AppState['transformMode'] }
  | { type: 'SET_SELECTED_POSE'; payload: Pose | null }
  | { type: 'ADD_TO_FAVORITES'; payload: string }
  | { type: 'REMOVE_FROM_FAVORITES'; payload: number }
  | { type: 'UPDATE_QUALITY_SETTINGS'; payload: Partial<AppState['qualitySettings']> }
  | { type: 'ADD_TO_PROMPT_HISTORY'; payload: string }
  | { type: 'SET_THEME'; payload: AppState['currentTheme'] }
  | { type: 'TOGGLE_QUALITY_SETTINGS' }
  | { type: 'TOGGLE_POSE_LIBRARY' }
  | { type: 'RESET_RESULTS' };
