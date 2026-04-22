import { create } from 'zustand';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import type {
  ExamSummary,
  QuestionSummary,
  QuestionDetail,
  ExamStatus,
  ExamResult,
  ValidationResponse,
} from '../types';
import { api, EnterFullscreen, ExitFullscreen } from '../api/client';

type View = 'setup' | 'exam' | 'score';
export type ExamMode = 'exam' | 'practice';

export type ClusterState = 'pending' | 'checking' | 'resetting' | 'creating' | 'ready' | 'error';

export interface ClusterProgress {
  name: string;
  state: ClusterState;
  message?: string;
}

export interface SetupProgress {
  step: string; // 'cluster' | 'prepare' | 'setup' | 'ready' | 'error'
  message: string;
  clusters: Record<string, ClusterProgress>;
  totalClusters: number;
  startedAt: number | null; // Date.now()
}

interface ExamStore {
  view: View;
  mode: ExamMode;
  exams: ExamSummary[];
  selectedExamId: string | null;
  questions: QuestionSummary[];
  currentQuestionId: string | null;
  currentQuestion: QuestionDetail | null;
  examStatus: ExamStatus | null;
  examResult: ExamResult | null;
  validationResult: ValidationResponse | null;
  flaggedQuestions: Set<string>;
  loading: boolean;
  error: string | null;
  progressMessage: string | null;
  setupProgress: SetupProgress | null;
  gradingMessage: string | null;

  setMode: (mode: ExamMode) => void;
  loadExams: () => Promise<void>;
  selectExam: (id: string) => Promise<void>;
  loadQuestions: () => Promise<void>;
  selectQuestion: (id: string) => Promise<void>;
  startExam: (duration: number) => Promise<void>;
  refreshStatus: () => Promise<void>;
  validateCurrent: () => Promise<void>;
  finishExam: () => Promise<void>;
  toggleFlag: (id: string) => void;
  reset: () => void;
}

export const useExam = create<ExamStore>((set, get) => ({
  view: 'setup',
  mode: 'exam',
  exams: [],
  selectedExamId: null,
  questions: [],
  currentQuestionId: null,
  currentQuestion: null,
  examStatus: null,
  examResult: null,
  validationResult: null,
  flaggedQuestions: new Set(),
  loading: false,
  error: null,
  progressMessage: null,
  setupProgress: null,
  gradingMessage: null,

  setMode: (mode: ExamMode) => set({ mode }),

  loadExams: async () => {
    try {
      const exams = await api.getExams();
      set({ exams });
      // Auto-select first exam if none selected
      if (exams.length > 0 && !get().selectedExamId) {
        get().selectExam(exams[0].id);
      }
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  selectExam: async (id: string) => {
    set({ selectedExamId: id });
    try {
      await api.selectExam(id);
      // Reload questions for this exam
      const questions = await api.getQuestions();
      set({ questions });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  loadQuestions: async () => {
    try {
      const questions = await api.getQuestions();
      set({ questions });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  selectQuestion: async (id: string) => {
    set({ currentQuestionId: id, validationResult: null });
    try {
      const detail = await api.getQuestion(id);
      set({ currentQuestion: detail });
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  startExam: async (duration: number) => {
    const startedAt = Date.now();
    set({
      loading: true,
      error: null,
      progressMessage: 'Initializing...',
      setupProgress: {
        step: 'init',
        message: 'Initializing...',
        clusters: {},
        totalClusters: 0,
        startedAt,
      },
    });

    const cancelListener = EventsOn('exam:progress', (data: any) => {
      if (!data || !data.message) return;

      const prev = get().setupProgress;
      const clusters = { ...(prev?.clusters || {}) };
      const totalClusters = data.totalClusters || prev?.totalClusters || 0;

      // Initialize cluster entries when we first get cluster names
      if (data.clusterNames && Object.keys(clusters).length === 0) {
        for (const name of data.clusterNames) {
          clusters[name] = { name, state: 'pending' };
        }
      }

      // Parse cluster state from message
      if (data.clusterName) {
        const cn = data.clusterName as string;
        const msg = (data.message as string).toLowerCase();
        let state: ClusterState = 'checking';
        if (msg.includes('ready')) state = 'ready';
        else if (msg.includes('creating')) state = 'creating';
        else if (msg.includes('resetting')) state = 'resetting';
        else if (msg.includes('deleting')) state = 'creating'; // treat delete+recreate as creating
        else if (msg.includes('healthy')) state = 'resetting';
        else if (msg.includes('error') || msg.includes('failed')) state = 'error';
        clusters[cn] = { name: cn, state, message: data.message };
      }

      set({
        progressMessage: data.message,
        setupProgress: {
          step: data.step || prev?.step || 'cluster',
          message: data.message,
          clusters,
          totalClusters,
          startedAt: prev?.startedAt || startedAt,
        },
      });
    });

    try {
      await api.startExam(duration);
      const status = await api.getExamStatus();
      const questions = get().questions;
      const firstId = questions[0]?.id;
      set({
        view: 'exam',
        examStatus: status,
        loading: false,
        progressMessage: null,
        setupProgress: null,
        flaggedQuestions: new Set(),
      });
      // Fullscreen disabled for now (interferes with screen recording)
      // try { await EnterFullscreen(); } catch { /* ignore if not supported */ }
      if (firstId) {
        get().selectQuestion(firstId);
      }
    } catch (e: any) {
      set({ error: e.message, loading: false, progressMessage: null, setupProgress: null });
    } finally {
      cancelListener();
    }
  },

  refreshStatus: async () => {
    try {
      const status = await api.getExamStatus();
      if (status.finished && get().view === 'exam') {
        const result = await api.finishExam();
        try { await ExitFullscreen(); } catch { /* ignore */ }
        set({ examResult: result, view: 'score', examStatus: status });
      } else {
        set({ examStatus: status });
      }
    } catch {
      // silent polling failure
    }
  },

  validateCurrent: async () => {
    const id = get().currentQuestionId;
    if (!id) return;
    set({ loading: true });
    try {
      const result = await api.validate(id);
      set({ validationResult: result, loading: false });
      get().refreshStatus();
    } catch (e: any) {
      set({ error: e.message, loading: false });
    }
  },

  finishExam: async () => {
    set({ loading: true, gradingMessage: 'Grading your answers...' });

    // Listen for grading progress events from backend
    const cancelListener = EventsOn('exam:progress', (data: any) => {
      if (data?.step === 'grading' && data?.message) {
        set({ gradingMessage: data.message });
      }
    });

    try {
      const result = await api.finishExam();
      // Exit fullscreen for score screen
      try { await ExitFullscreen(); } catch { /* ignore */ }
      set({ examResult: result, view: 'score', loading: false, gradingMessage: null });
    } catch (e: any) {
      set({ error: e.message, loading: false, gradingMessage: null });
    } finally {
      cancelListener();
    }
  },

  toggleFlag: (id: string) => {
    const flagged = new Set(get().flaggedQuestions);
    if (flagged.has(id)) {
      flagged.delete(id);
    } else {
      flagged.add(id);
    }
    set({ flaggedQuestions: flagged });
  },

  reset: () => {
    // Exit fullscreen when going back to setup
    try { ExitFullscreen(); } catch { /* ignore */ }
    set({
      view: 'setup',
      currentQuestionId: null,
      currentQuestion: null,
      examStatus: null,
      examResult: null,
      validationResult: null,
      flaggedQuestions: new Set(),
      loading: false,
      error: null,
      progressMessage: null,
      setupProgress: null,
      gradingMessage: null,
    });
    // Reload exams and questions
    get().loadExams();
  },
}));
