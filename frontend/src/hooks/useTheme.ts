import { create } from 'zustand';

type Theme = 'light' | 'dark';

interface ThemeStore {
  theme: Theme;
  toggle: () => void;
  isDark: boolean;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  theme: 'light',
  isDark: false,
  toggle: () => {
    const next = get().theme === 'light' ? 'dark' : 'light';
    set({ theme: next, isDark: next === 'dark' });
  },
}));

// Color tokens for each theme
export function colors(isDark: boolean) {
  if (isDark) {
    return {
      // Page / cards
      pageBg: '#0f172a',
      cardBg: '#1e293b',
      cardBorder: '#334155',

      // Question panel
      questionBg: '#1e293b',
      questionText: '#cbd5e1',
      questionHeading: '#f1f5f9',
      questionMuted: '#94a3b8',
      questionBorder: '#334155',
      codeBg: '#0f172a',
      codeText: '#38bdf8',
      codeBorder: '#334155',

      // Header
      headerBg: '#1e293b',
      headerBorder: '#334155',

      // Nav
      navBg: '#0f172a',
      navBorder: '#334155',
      navPillDefault: '#475569',

      // Tabs
      tabBarBg: '#1e293b',
      tabBorder: '#334155',
      tabActive: '#0f172a',
      tabText: '#94a3b8',
      tabActiveText: '#e2e8f0',

      // Buttons
      btnSecondaryBg: '#334155',
      btnSecondaryText: '#e2e8f0',
      btnSecondaryBorder: '#475569',

      // Context badge
      contextBg: '#0f172a',
      contextBorder: '#334155',
      contextText: '#94a3b8',

      // Hint
      hintBg: '#422006',
      hintBorder: '#f59e0b',
      hintText: '#fbbf24',

      // Validation
      validationBorder: '#334155',

      // Input / misc
      inputBg: '#0f172a',
      inputBorder: '#334155',
      inputText: '#e2e8f0',

      // Error
      errorBg: '#450a0a',
      errorBorder: '#7f1d1d',
      errorText: '#fca5a5',

      // Progress
      progressBg: '#0c1a3d',
      progressBorder: '#1e3a5f',
      progressText: '#93c5fd',

      // Status
      statusText: '#e2e8f0',
      statusMuted: '#94a3b8',
    };
  }

  return {
    // Page / cards
    pageBg: '#f1f5f9',
    cardBg: '#ffffff',
    cardBorder: '#e2e8f0',

    // Question panel
    questionBg: '#ffffff',
    questionText: '#334155',
    questionHeading: '#0f172a',
    questionMuted: '#64748b',
    questionBorder: '#f1f5f9',
    codeBg: '#f1f5f9',
    codeText: '#be185d',
    codeBorder: '#e2e8f0',

    // Header
    headerBg: '#326ce5',
    headerBorder: '#326ce5',

    // Nav
    navBg: '#f1f5f9',
    navBorder: '#e2e8f0',
    navPillDefault: '#cbd5e1',

    // Tabs
    tabBarBg: '#2d2d2d',
    tabBorder: '#404040',
    tabActive: '#1e1e1e',
    tabText: '#999999',
    tabActiveText: '#ffffff',

    // Buttons
    btnSecondaryBg: '#ffffff',
    btnSecondaryText: '#475569',
    btnSecondaryBorder: '#cbd5e1',

    // Context badge
    contextBg: '#f8fafc',
    contextBorder: '#e2e8f0',
    contextText: '#475569',

    // Hint
    hintBg: '#fffbeb',
    hintBorder: '#f59e0b',
    hintText: '#92400e',

    // Validation
    validationBorder: '#f1f5f9',

    // Input / misc
    inputBg: '#f8fafc',
    inputBorder: '#e2e8f0',
    inputText: '#334155',

    // Error
    errorBg: '#fef2f2',
    errorBorder: '#fecaca',
    errorText: '#dc2626',

    // Progress
    progressBg: '#eff6ff',
    progressBorder: '#bfdbfe',
    progressText: '#1d4ed8',

    // Status
    statusText: '#334155',
    statusMuted: '#94a3b8',
  };
}
