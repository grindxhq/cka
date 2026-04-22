import { create } from 'zustand';

type Theme = 'light' | 'dark';

interface ThemeStore {
  theme: Theme;
  toggle: () => void;
  isDark: boolean;
}

export const useTheme = create<ThemeStore>((set, get) => ({
  theme: 'dark',
  isDark: true,
  toggle: () => {
    const next = get().theme === 'light' ? 'dark' : 'light';
    set({ theme: next, isDark: next === 'dark' });
  },
}));

// Color tokens for each theme
export function colors(isDark: boolean) {
  if (isDark) {
    return {
      // Page / cards — lifted from near-black to visible dark gray
      pageBg: '#111114',
      cardBg: '#1c1c21',
      cardBorder: '#2e2e35',

      // Question panel
      questionBg: '#1c1c21',
      questionText: '#d4d4d8',
      questionHeading: '#f4f4f5',
      questionMuted: '#a1a1aa',
      questionBorder: '#2e2e35',
      codeBg: '#141417',
      codeText: '#22d3ee',
      codeBorder: '#2e2e35',

      // Header
      headerBg: '#1c1c21',
      headerBorder: '#2e2e35',

      // Nav
      navBg: '#141417',
      navBorder: '#2e2e35',
      navPillDefault: '#52525b',

      // Tabs
      tabBarBg: '#1c1c21',
      tabBorder: '#2e2e35',
      tabActive: '#111114',
      tabText: '#a1a1aa',
      tabActiveText: '#f4f4f5',

      // Buttons
      btnSecondaryBg: '#2e2e35',
      btnSecondaryText: '#f4f4f5',
      btnSecondaryBorder: '#3f3f46',

      // Context badge
      contextBg: '#141417',
      contextBorder: '#2e2e35',
      contextText: '#a1a1aa',

      // Hint
      hintBg: '#422006',
      hintBorder: '#fbbf24',
      hintText: '#fbbf24',

      // Validation
      validationBorder: '#2e2e35',

      // Input / misc
      inputBg: '#141417',
      inputBorder: '#2e2e35',
      inputText: '#f4f4f5',

      // Error
      errorBg: '#450a0a',
      errorBorder: '#7f1d1d',
      errorText: '#fca5a5',

      // Progress
      progressBg: '#0f1d30',
      progressBorder: '#1e3a5f',
      progressText: '#67e8f9',

      // Status
      statusText: '#f4f4f5',
      statusMuted: '#a1a1aa',
    };
  }

  return {
    // Page / cards
    pageBg: '#f4f4f5',      // zinc-100
    cardBg: '#ffffff',
    cardBorder: '#e4e4e7',   // zinc-200

    // Question panel
    questionBg: '#ffffff',
    questionText: '#3f3f46',  // zinc-700
    questionHeading: '#18181b', // zinc-900
    questionMuted: '#71717a',  // zinc-500
    questionBorder: '#f4f4f5',
    codeBg: '#f4f4f5',
    codeText: '#0891b2',     // cyan-600
    codeBorder: '#e4e4e7',

    // Header
    headerBg: '#0891b2',     // cyan-600
    headerBorder: '#0891b2',

    // Nav
    navBg: '#f4f4f5',
    navBorder: '#e4e4e7',
    navPillDefault: '#d4d4d8', // zinc-300

    // Tabs (always dark — terminal area)
    tabBarBg: '#18181b',
    tabBorder: '#27272a',
    tabActive: '#09090b',
    tabText: '#a1a1aa',
    tabActiveText: '#ffffff',

    // Buttons
    btnSecondaryBg: '#ffffff',
    btnSecondaryText: '#52525b', // zinc-600
    btnSecondaryBorder: '#d4d4d8',

    // Context badge
    contextBg: '#fafafa',
    contextBorder: '#e4e4e7',
    contextText: '#52525b',

    // Hint
    hintBg: '#fffbeb',
    hintBorder: '#f59e0b',
    hintText: '#92400e',

    // Validation
    validationBorder: '#f4f4f5',

    // Input / misc
    inputBg: '#fafafa',       // zinc-50
    inputBorder: '#e4e4e7',
    inputText: '#3f3f46',

    // Error
    errorBg: '#fef2f2',
    errorBorder: '#fecaca',
    errorText: '#dc2626',

    // Progress
    progressBg: '#ecfeff',    // cyan-50
    progressBorder: '#a5f3fc', // cyan-200
    progressText: '#0e7490',   // cyan-700

    // Status
    statusText: '#3f3f46',
    statusMuted: '#a1a1aa',
  };
}
