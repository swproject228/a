
import React, { useReducer, useRef, useCallback, useEffect } from 'react';
import { NUDITY_LEVELS, OUTFIT_LIBRARY, POSE_LIBRARY, AUTO_SCENARIOS, PROTECTION_FRAMES, TRANSFORMATION_MODES, THEMES } from './constants';
import { AppState, AppAction, Outfit, Pose } from './types';
import { generateImage } from './services/geminiService';
import { SparklesIcon, SettingsIcon, HeartIcon, DownloadIcon, TrashIcon } from './components/icons';

const initialState: AppState = {
  originalImage: null,
  originalImageMimeType: null,
  currentLevel: 1,
  transformationHistory: [],
  results: [null, null, null, null],
  loadingStates: [false, false, false, false],
  errors: [null, null, null, null],
  autoMode: false,
  selectedScenario: null,
  autoRunning: false,
  currentStep: 0,
  successRate: { successful: 0, failed: 0, blocked: 0 },
  retryAttempts: [0, 0, 0, 0],
  lockSeed: true,
  currentSeed: null,
  progressLog: [],
  sessionStarted: null,
  transformMode: 'CLOTHING',
  selectedPose: null,
  favorites: [],
  qualitySettings: { steps: 30, guidanceScale: 7.5, strength: 0.7 },
  promptHistory: [],
  currentTheme: 'dark',
  showQualitySettings: false,
  showPoseLibrary: false,
};

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_ORIGINAL_IMAGE':
      const newHistoryItem = { level: 1, image: action.payload.image, prompt: "Initial Image", timestamp: Date.now(), success: true };
      return {
        ...state,
        originalImage: action.payload.image,
        originalImageMimeType: action.payload.mimeType,
        currentLevel: 1,
        transformationHistory: [newHistoryItem],
        sessionStarted: state.sessionStarted ?? Date.now(),
        results: [null, null, null, null],
        errors: [null, null, null, null],
        loadingStates: [false, false, false, false]
      };
    case 'SET_LEVEL': return { ...state, currentLevel: action.payload };
    case 'ADD_TO_HISTORY': return { ...state, transformationHistory: [...state.transformationHistory, action.payload] };
    case 'SET_RESULT':
      const newResults = [...state.results];
      newResults[action.payload.index] = action.payload.result;
      return { ...state, results: newResults };
    case 'SET_LOADING':
      const newLoadingStates = [...state.loadingStates];
      newLoadingStates[action.payload.index] = action.payload.isLoading;
      return { ...state, loadingStates: newLoadingStates };
    case 'SET_ERROR':
      const newErrors = [...state.errors];
      newErrors[action.payload.index] = action.payload.error;
      return { ...state, errors: newErrors };
    case 'INCREMENT_RETRY':
      const newRetries = [...state.retryAttempts];
      newRetries[action.payload]++;
      return { ...state, retryAttempts: newRetries };
    case 'UPDATE_SUCCESS_RATE':
      return {
        ...state,
        successRate: {
          successful: state.successRate.successful + (action.payload.success ? 1 : 0),
          failed: state.successRate.failed + (!action.payload.success && !action.payload.blocked ? 1 : 0),
          blocked: state.successRate.blocked + (action.payload.blocked ? 1 : 0)
        }
      };
    case 'ADD_LOG': return { ...state, progressLog: [{ message: action.payload, timestamp: Date.now() }, ...state.progressLog].slice(0, 50) };
    case 'SET_AUTO_MODE': return { ...state, autoMode: action.payload };
    case 'SET_SCENARIO': return { ...state, selectedScenario: action.payload };
    case 'SET_AUTO_RUNNING': return { ...state, autoRunning: action.payload };
    case 'SET_CURRENT_STEP': return { ...state, currentStep: action.payload };
    case 'SET_SEED': return { ...state, currentSeed: action.payload };
    case 'TOGGLE_LOCK_SEED': return { ...state, lockSeed: !state.lockSeed };
    case 'SET_TRANSFORM_MODE': return { ...state, transformMode: action.payload };
    case 'SET_SELECTED_POSE': return { ...state, selectedPose: action.payload };
    case 'ADD_TO_FAVORITES': return { ...state, favorites: [...state.favorites, { image: action.payload, timestamp: Date.now(), id: Date.now() }] };
    case 'REMOVE_FROM_FAVORITES': return { ...state, favorites: state.favorites.filter(f => f.id !== action.payload) };
    case 'UPDATE_QUALITY_SETTINGS': return { ...state, qualitySettings: { ...state.qualitySettings, ...action.payload } };
    case 'ADD_TO_PROMPT_HISTORY': return { ...state, promptHistory: [{ prompt: action.payload, timestamp: Date.now(), id: Date.now() }, ...state.promptHistory].slice(0, 20) };
    case 'SET_THEME': return { ...state, currentTheme: action.payload };
    case 'TOGGLE_QUALITY_SETTINGS': return { ...state, showQualitySettings: !state.showQualitySettings };
    case 'TOGGLE_POSE_LIBRARY': return { ...state, showPoseLibrary: !state.showPoseLibrary };
    case 'RESET_RESULTS': return { ...state, results: [null, null, null, null], errors: [null, null, null, null], loadingStates: [false, false, false, false], retryAttempts: [0, 0, 0, 0] };
    default: return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const theme = THEMES[state.currentTheme];

  const buildProtectedPrompt = useCallback((outfit: Outfit, level: number, index: number, retryCount: number = 0) => {
    const protectionFrame = PROTECTION_FRAMES[retryCount % PROTECTION_FRAMES.length];
    const extraProtection = level >= 4 ? PROTECTION_FRAMES.slice(0, 3).join('. ') : '';
    let prompt = `${protectionFrame}. ${extraProtection} Character design: ${outfit.prompt}. `;

    if (state.transformMode === 'CLOTHING') {
      prompt += `IMPORTANT: Maintain EXACT same character face, EXACT same pose, EXACT same camera angle, EXACT same background, EXACT same art style. ONLY clothing changes. `;
    } else if (state.transformMode === 'POSE' && state.selectedPose) {
      prompt += `IMPORTANT: ${state.selectedPose.prompt}. Maintain EXACT same character face, EXACT same outfit, EXACT same background. ONLY pose changes. `;
    } else if (state.transformMode === 'BALANCED') {
      prompt += `Keep same character identity, same general composition, allow slight variations. `;
    } else if (state.transformMode === 'FREE') {
      prompt += `Creative interpretation allowed, maintain character essence. `;
    }

    if (level >= 4) {
      const semanticMasks = ['Focus on emotional vulnerability and character development.', 'Artistic expression of intimacy and trust.', 'Character personality through fashion storytelling.', 'Romantic mood emphasizing emotional connection.'];
      prompt += `${semanticMasks[index % semanticMasks.length]} `;
    }
    prompt += `High quality, detailed, professional art. `;
    dispatch({ type: 'ADD_LOG', payload: `🎨 Промпт построен (попытка ${retryCount + 1})` });
    return prompt;
  }, [state.transformMode, state.selectedPose]);
  
  const generateWithRetry = useCallback(async (outfit: Outfit, level: number, index: number, maxRetries = 5) => {
    dispatch({ type: 'SET_LOADING', payload: { index, isLoading: true } });
    dispatch({ type: 'SET_ERROR', payload: { index, error: null } });
  
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (!state.originalImage || !state.originalImageMimeType) {
        dispatch({ type: 'SET_ERROR', payload: { index, error: "Нет исходного изображения." } });
        dispatch({ type: 'SET_LOADING', payload: { index, isLoading: false } });
        return null;
      }
      
      try {
        dispatch({ type: 'ADD_LOG', payload: `🔄 Попытка ${attempt + 1}/${maxRetries} для варианта ${index + 1}` });
        const prompt = buildProtectedPrompt(outfit, level, index, attempt);
        
        if (attempt > 0) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          dispatch({ type: 'ADD_LOG', payload: `⏳ Ожидание ${delay}ms...` });
          await new Promise(resolve => setTimeout(resolve, delay));
        }
  
        const resultImage = await generateImage(state.originalImage, state.originalImageMimeType, prompt);
        
        dispatch({ type: 'SET_RESULT', payload: { index, result: resultImage } });
        dispatch({ type: 'UPDATE_SUCCESS_RATE', payload: { success: true } });
        dispatch({ type: 'ADD_LOG', payload: `✅ Успешно сгенерировано для варианта ${index + 1}` });
        dispatch({ type: 'ADD_TO_PROMPT_HISTORY', payload: prompt });
        dispatch({ type: 'ADD_TO_HISTORY', payload: { level, image: resultImage, prompt, success: true, timestamp: Date.now() } });
        dispatch({ type: 'SET_LOADING', payload: { index, isLoading: false } });
        return resultImage;
  
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed:`, error);
        const errorMessage = (error as Error).message;
        const isBlocked = errorMessage.toLowerCase().includes("blocked");
        dispatch({ type: 'ADD_LOG', payload: `❌ ${isBlocked ? '🚫 Заблокировано' : 'Ошибка'} на попытке ${attempt + 1}: ${errorMessage}` });
        dispatch({ type: 'INCREMENT_RETRY', payload: index });
  
        if (attempt === maxRetries - 1) {
          dispatch({ type: 'SET_ERROR', payload: { index, error: `❌ Провалены все ${maxRetries} попыток. ${isBlocked ? 'Блокировка API.' : ''}` } });
          dispatch({ type: 'UPDATE_SUCCESS_RATE', payload: { success: false, blocked: isBlocked } });
          dispatch({ type: 'ADD_LOG', payload: `💥 Все попытки исчерпаны для варианта ${index + 1}` });
          dispatch({ type: 'SET_LOADING', payload: { index, isLoading: false } });
          return null;
        }
      }
    }
    return null;
  }, [state.originalImage, state.originalImageMimeType, buildProtectedPrompt]);

  const handleOutfitSelect = async (level: number, outfitIndex: number) => {
    if (!state.originalImage) {
      alert('⚠️ Загрузите изображение!');
      return;
    }
    const outfit = OUTFIT_LIBRARY[`level${level}`][outfitIndex];
    dispatch({ type: 'ADD_LOG', payload: `🎯 Выбран наряд: ${outfit.name} (уровень ${level})` });
    dispatch({ type: 'RESET_RESULTS' });
    dispatch({ type: 'SET_LEVEL', payload: level });
    
    for (const i of [0, 1, 2, 3]) {
      await generateWithRetry(outfit, level, i);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if(typeof event.target?.result === 'string') {
          dispatch({ type: 'SET_ORIGINAL_IMAGE', payload: { image: event.target.result, mimeType: file.type } });
          dispatch({ type: 'ADD_LOG', payload: '📁 Изображение загружено' });
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSelectResult = (index: number) => {
    const selectedImage = state.results[index];
    if (selectedImage) {
        const mimeType = selectedImage.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
        dispatch({ type: 'SET_ORIGINAL_IMAGE', payload: { image: selectedImage, mimeType } });
        dispatch({ type: 'ADD_LOG', payload: `✨ Вариант ${index + 1} выбран как новое опорное изображение` });
    }
  };
  
  useEffect(() => {
    let isMounted = true;
    const runScenario = async () => {
        if (!state.autoRunning || !state.selectedScenario || !state.originalImage) {
            if (state.autoRunning) dispatch({ type: 'SET_AUTO_RUNNING', payload: false });
            return;
        }

        const scenario = AUTO_SCENARIOS[state.selectedScenario];
        if (!scenario || state.currentStep >= scenario.steps.length) {
            dispatch({ type: 'SET_AUTO_RUNNING', payload: false });
            dispatch({ type: 'ADD_LOG', payload: `🏁 Сценарий завершён!` });
            return;
        }

        const step = scenario.steps[state.currentStep];
        dispatch({ type: 'ADD_LOG', payload: `📍 Шаг ${state.currentStep + 1}/${scenario.steps.length}: Уровень ${step.level}` });

        if (state.currentStep > 0 && scenario.steps[state.currentStep - 1].delay > 0) {
            await new Promise(resolve => setTimeout(resolve, scenario.steps[state.currentStep - 1].delay));
        }
        if (!isMounted) return;

        const outfit = OUTFIT_LIBRARY[`level${step.level}`][step.outfit];
        const result = await generateWithRetry(outfit, step.level, 0);

        if (!isMounted) return;

        if (result) {
            const mimeType = result.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
            dispatch({ type: 'SET_ORIGINAL_IMAGE', payload: { image: result, mimeType: mimeType } });
            dispatch({ type: 'SET_LEVEL', payload: step.level });
            dispatch({ type: 'SET_CURRENT_STEP', payload: state.currentStep + 1 });
        } else {
            dispatch({ type: 'ADD_LOG', payload: `⚠️ Шаг ${state.currentStep + 1} провален, прерывание сценария` });
            dispatch({ type: 'SET_AUTO_RUNNING', payload: false });
        }
    };

    runScenario();

    return () => { isMounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.autoRunning, state.currentStep]);

  const startAutoScenario = () => {
      if (!state.originalImage) { alert('⚠️ Загрузите изображение!'); return; }
      if (!state.selectedScenario) { alert('⚠️ Выберите сценарий!'); return; }
      const scenario = AUTO_SCENARIOS[state.selectedScenario];
      dispatch({ type: 'RESET_RESULTS' });
      dispatch({ type: 'SET_CURRENT_STEP', payload: 0 });
      dispatch({ type: 'SET_AUTO_RUNNING', payload: true });
      dispatch({ type: 'ADD_LOG', payload: `🚀 Запуск сценария: ${scenario.name}` });
  };


  const totalAttempts = state.successRate.successful + state.successRate.failed + state.successRate.blocked;
  const successPercentage = totalAttempts > 0 ? Math.round((state.successRate.successful / totalAttempts) * 100) : 0;
  const blockPercentage = totalAttempts > 0 ? Math.round((state.successRate.blocked / totalAttempts) * 100) : 0;

  return (
    <div className="max-w-7xl mx-auto p-2 sm:p-5 font-sans min-h-screen" style={{ backgroundColor: theme.bg, color: theme.text }}>
      <style>{`:root { --theme-bg: ${theme.bg}; --theme-cardBg: ${theme.cardBg}; --theme-cardBgSecondary: ${theme.cardBgSecondary}; --theme-text: ${theme.text}; --theme-textSecondary: ${theme.textSecondary}; --theme-accent: ${theme.accent}; --theme-accentSecondary: ${theme.accentSecondary}; --theme-border: ${theme.border}; }`}</style>

      {/* HEADER */}
      <header className="mb-6 p-6 rounded-2xl shadow-2xl" style={{ background: `linear-gradient(135deg, ${theme.accent} 0%, ${theme.accentSecondary} 100%)` }}>
        <h1 className="text-3xl md:text-4xl font-bold flex items-center gap-4 text-white">
            {TRANSFORMATION_MODES[state.transformMode].icon} Progressive AI Transformation
        </h1>
        <p className="mt-2 text-lg opacity-90 text-white">Генератор изображений через Gemini 2.5 Flash Image</p>
        <div className="mt-4 flex flex-wrap gap-3">
          {Object.entries(THEMES).map(([key, themeData]) => (
            <button key={key} onClick={() => dispatch({ type: 'SET_THEME', payload: key as AppState['currentTheme'] })}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${state.currentTheme === key ? 'ring-2 ring-offset-2 ring-offset-[var(--theme-accent)] ring-white' : ''}`}
              style={{ backgroundColor: state.currentTheme === key ? theme.accent : theme.cardBgSecondary, color: theme.text }}>
              {themeData.name}
            </button>
          ))}
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT COLUMN - CONTROLS */}
        <div className="lg:col-span-1 flex flex-col gap-6">
          {/* IMAGE UPLOADER */}
          <div className="p-4 sm:p-6 rounded-2xl border-2 border-dashed" style={{ backgroundColor: theme.cardBg, borderColor: theme.accent }}>
            <button onClick={() => fileInputRef.current?.click()} className="w-full p-4 text-lg font-bold text-white rounded-xl transition transform hover:scale-105" style={{ background: `linear-gradient(135deg, ${theme.accent}, ${theme.accentSecondary})` }}>
              📸 Загрузить изображение
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
            {state.originalImage && (
              <div className="mt-4 text-center">
                <div className="inline-block px-3 py-1 rounded-md font-bold text-black mb-3" style={{ backgroundColor: NUDITY_LEVELS[state.currentLevel].color }}>
                  {NUDITY_LEVELS[state.currentLevel].name}
                </div>
                <img src={state.originalImage} alt="Original" className="max-w-full max-h-[400px] rounded-lg mx-auto border-4" style={{ borderColor: NUDITY_LEVELS[state.currentLevel].color }}/>
              </div>
            )}
          </div>
          
          {/* SETTINGS */}
          <div className="p-4 sm:p-6 rounded-2xl" style={{backgroundColor: theme.cardBg}}>
             {/* Transformation Mode */}
             <h2 className="text-xl font-bold mb-4">🎯 Режим трансформации</h2>
             <div className="grid grid-cols-2 gap-3 mb-4">
                 {Object.entries(TRANSFORMATION_MODES).map(([key, mode]) => (
                     <button key={key} onClick={() => dispatch({ type: 'SET_TRANSFORM_MODE', payload: key as AppState['transformMode'] })} disabled={state.autoRunning}
                         className={`p-3 rounded-lg border-2 transition-all ${state.transformMode === key ? 'text-white' : ''}`}
                         style={{ backgroundColor: state.transformMode === key ? theme.accent : theme.cardBgSecondary, borderColor: state.transformMode === key ? theme.accent : theme.border }}>
                         <div className="text-3xl mb-1">{mode.icon}</div>
                         <div className="font-bold text-sm">{mode.name}</div>
                     </button>
                 ))}
             </div>

            {/* Quality Settings */}
            <button onClick={() => dispatch({type: 'TOGGLE_QUALITY_SETTINGS'})} className="w-full flex justify-between items-center p-3 font-bold text-lg rounded-lg mb-2" style={{backgroundColor: theme.cardBgSecondary}}>
              <span className="flex items-center gap-2"><SettingsIcon className="w-6 h-6"/> Настройки качества</span>
              <span>{state.showQualitySettings ? '▲' : '▼'}</span>
            </button>
            {state.showQualitySettings && (
              <div className="grid gap-4 p-3 rounded-lg" style={{backgroundColor: theme.cardBgSecondary}}>
                <p className='text-sm text-center' style={{color: theme.textSecondary}}>Эти настройки предназначены для визуализации и не влияют на модель Gemini.</p>
                <div>
                  <label className="block mb-1 font-semibold">Steps: {state.qualitySettings.steps}</label>
                  <input type="range" min="20" max="50" value={state.qualitySettings.steps} onChange={(e) => dispatch({ type: 'UPDATE_QUALITY_SETTINGS', payload: { steps: parseInt(e.target.value) } })} className="w-full" />
                </div>
                <div>
                  <label className="block mb-1 font-semibold">Guidance Scale: {state.qualitySettings.guidanceScale}</label>
                  <input type="range" min="5" max="15" step="0.5" value={state.qualitySettings.guidanceScale} onChange={(e) => dispatch({ type: 'UPDATE_QUALITY_SETTINGS', payload: { guidanceScale: parseFloat(e.target.value) } })} className="w-full" />
                </div>
                <div>
                  <label className="block mb-1 font-semibold">Strength: {state.qualitySettings.strength}</label>
                  <input type="range" min="0.3" max="0.9" step="0.05" value={state.qualitySettings.strength} onChange={(e) => dispatch({ type: 'UPDATE_QUALITY_SETTINGS', payload: { strength: parseFloat(e.target.value) } })} className="w-full" />
                </div>
              </div>
            )}
          </div>
          
          {/* LOGS */}
          <div className="p-4 sm:p-6 rounded-2xl" style={{backgroundColor: theme.cardBg}}>
            <h2 className="text-xl font-bold mb-4">📋 Лог прогресса</h2>
            <div className="h-64 overflow-y-auto p-3 rounded-lg bg-black/30 text-sm font-mono space-y-2">
                {state.progressLog.map((log, i) => (
                    <div key={i} className="flex gap-2 items-start">
                        <span className="opacity-50 flex-shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
                        <p className="break-words">{log.message}</p>
                    </div>
                ))}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN - MAIN CONTENT */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          {/* MODE SWITCHER */}
          <div className="grid grid-cols-2 gap-4">
              <button onClick={() => dispatch({ type: 'SET_AUTO_MODE', payload: false })}
                className={`p-4 rounded-xl text-center font-bold border-4 transition-all ${!state.autoMode ? 'text-white' : ''}`}
                style={{ background: !state.autoMode ? `linear-gradient(135deg, ${theme.accent}, ${theme.accentSecondary})` : theme.cardBgSecondary, borderColor: !state.autoMode ? theme.accent : theme.border }}>
                  <div className="text-4xl mb-2">🎨</div> Ручной режим
              </button>
              <button onClick={() => dispatch({ type: 'SET_AUTO_MODE', payload: true })}
                className={`p-4 rounded-xl text-center font-bold border-4 transition-all ${state.autoMode ? 'text-white' : ''}`}
                style={{ background: state.autoMode ? `linear-gradient(135deg, ${theme.accent}, ${theme.accentSecondary})` : theme.cardBgSecondary, borderColor: state.autoMode ? theme.accent : theme.border }}>
                  <div className="text-4xl mb-2">🤖</div> Авто-режим
              </button>
          </div>
            
          {/* OUTFIT/SCENARIO SELECTION */}
          {!state.autoMode ? (
              <div className='space-y-4'>
                {Object.entries(NUDITY_LEVELS).map(([levelNum, levelInfo]) => {
                  const level = parseInt(levelNum);
                  return (
                    <div key={level} className="p-4 rounded-xl border-2" style={{ backgroundColor: theme.cardBg, borderColor: theme.border }}>
                      <div className="flex justify-between items-center mb-4">
                        <h3 className="text-xl font-bold" style={{ color: levelInfo.color }}>{levelInfo.name}</h3>
                        <span className="px-3 py-1 text-sm font-bold rounded-full" style={{ backgroundColor: levelInfo.color, color: level > 3 ? 'white' : 'black' }}>{levelInfo.safety}</span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                        {OUTFIT_LIBRARY[`level${level}`].map((outfit, idx) => (
                          <button key={idx} onClick={() => handleOutfitSelect(level, idx)} disabled={!state.originalImage || state.autoRunning}
                            className="p-3 text-center rounded-lg border-2 transition-all transform hover:-translate-y-1 disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ backgroundColor: theme.cardBgSecondary, borderColor: levelInfo.color }}>
                            <div className="text-4xl mb-2">{outfit.preview}</div>
                            <div className="font-semibold text-sm">{outfit.name}</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
          ) : (
            <div className="p-4 sm:p-6 rounded-2xl" style={{ backgroundColor: theme.cardBg }}>
                <h2 className="text-2xl font-bold mb-4">🤖 Автоматические сценарии</h2>
                <div className="space-y-3 mb-4">
                  {Object.entries(AUTO_SCENARIOS).map(([key, scenario]) => (
                    <button key={key} onClick={() => dispatch({ type: 'SET_SCENARIO', payload: key })} disabled={state.autoRunning}
                      className={`w-full p-4 text-left rounded-xl border-2 transition-all ${state.selectedScenario === key ? 'ring-2 ring-offset-2 ring-[var(--theme-accent)] ring-offset-[var(--theme-bg)]' : ''}`}
                      style={{ backgroundColor: theme.cardBgSecondary, borderColor: state.selectedScenario === key ? theme.accent : theme.border }}>
                      <h3 className="font-bold text-lg">{scenario.name}</h3>
                      <p className="text-sm opacity-80">{scenario.description}</p>
                      <div className="mt-2 text-xs font-semibold">{scenario.steps.length} шагов • {scenario.safety}</div>
                    </button>
                  ))}
                </div>
                <button onClick={startAutoScenario} disabled={state.autoRunning || !state.originalImage || !state.selectedScenario}
                  className="w-full p-4 text-xl font-bold text-white rounded-xl transition transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: `linear-gradient(135deg, ${theme.accent}, ${theme.accentSecondary})` }}>
                  {state.autoRunning ? `⏳ Выполнение... Шаг ${state.currentStep + 1}` : '🚀 Запустить'}
                </button>
            </div>
          )}

          {/* RESULTS */}
          <div className="p-4 sm:p-6 rounded-2xl" style={{ backgroundColor: theme.cardBg }}>
            <h2 className="text-2xl font-bold mb-4">🎨 Результаты генерации</h2>
             <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {state.results.map((result, idx) => (
                    <div key={idx} className="p-3 rounded-lg" style={{ backgroundColor: theme.cardBgSecondary }}>
                        <h3 className="font-bold mb-2">Вариант {idx + 1}</h3>
                        {state.loadingStates[idx] ? (
                           <div className="h-64 flex flex-col items-center justify-center rounded-lg animate-pulse" style={{backgroundColor: theme.bg}}>
                                <div className="text-4xl">⏳</div>
                                <div className="mt-2 font-semibold">Генерация...</div>
                           </div>
                        ) : state.errors[idx] ? (
                            <div className="h-64 flex items-center justify-center text-center p-4 rounded-lg bg-red-500/20 text-red-400">
                                {state.errors[idx]}
                            </div>
                        ) : result ? (
                            <div>
                                <img src={result} alt={`Result ${idx}`} className="w-full rounded-lg mb-2 border-2" style={{borderColor: theme.accent}}/>
                                <div className="grid grid-cols-3 gap-2">
                                    <button onClick={() => handleSelectResult(idx)} className="col-span-3 sm:col-span-1 flex items-center justify-center gap-2 p-2 rounded-md font-semibold text-white transition" style={{backgroundColor: theme.accent}}><SparklesIcon className="w-5 h-5"/> Использовать</button>
                                    <button onClick={() => dispatch({ type: 'ADD_TO_FAVORITES', payload: result })} className="p-2 rounded-md transition" style={{backgroundColor: theme.cardBg, border: `1px solid ${theme.border}`}}><HeartIcon className="w-5 h-5 mx-auto"/></button>
                                    <button onClick={() => { const a = document.createElement('a'); a.href = result; a.download = `result_${Date.now()}.png`; a.click(); }} className="p-2 rounded-md transition" style={{backgroundColor: theme.cardBg, border: `1px solid ${theme.border}`}}><DownloadIcon className="w-5 h-5 mx-auto"/></button>
                                </div>
                            </div>
                        ) : <div className="h-64 flex items-center justify-center rounded-lg text-center" style={{backgroundColor: theme.bg}}><span style={{color: theme.textSecondary}}>Здесь будет результат</span></div>}
                    </div>
                ))}
             </div>
          </div>

          {/* FAVORITES */}
          {state.favorites.length > 0 && (
            <div className="p-4 sm:p-6 rounded-2xl" style={{ backgroundColor: theme.cardBg }}>
              <h2 className="text-2xl font-bold mb-4">💖 Избранное ({state.favorites.length})</h2>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {state.favorites.map(fav => (
                  <div key={fav.id} className="relative group">
                    <img src={fav.image} alt="Favorite" className="w-full rounded-lg aspect-square object-cover"/>
                    <button onClick={() => dispatch({type: 'REMOVE_FROM_FAVORITES', payload: fav.id})} className="absolute top-1 right-1 p-1 bg-black/50 text-white rounded-full opacity-0 group-hover:opacity-100 transition">
                      <TrashIcon className="w-4 h-4"/>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
