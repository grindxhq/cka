export interface ClusterConfig {
  name: string;
  nodes: number;
  workers: number;
  controlPlane: number;
}

export interface ExamSummary {
  id: string;
  name: string;
  description: string;
  duration: number;
  difficulty: string;
  passScore: number;
  clusters: ClusterConfig[];
  tags?: string[];
  questionCount: number;
  totalWeight: number;
}

export interface QuestionSummary {
  id: string;
  title: string;
  category: string;
  difficulty: string;
  weight: number;
}

export interface DeckTopicSummary {
  id: string;
  title: string;
  description: string;
  component?: string;
  domain?: string;
  tags?: string[];
  subtopicCount: number;
}

export interface DeckSubtopic {
  id: string;
  title: string;
  summary?: string;
  content: string;
  tags?: string[];
}

export interface DeckTopic {
  id: string;
  title: string;
  description: string;
  component?: string;
  domain?: string;
  tags?: string[];
  subtopics: DeckSubtopic[];
  subtopicCount: number;
}

export interface QuestionDetail {
  id: string;
  title: string;
  category: string;
  difficulty: string;
  weight: number;
  context: string;
  task: string;
  guide?: string;
  hint?: string;
  solution?: string;
}

export interface QuestionStatus {
  attempted: boolean;
  passed: boolean;
}

export interface ExamStatus {
  started: boolean;
  finished: boolean;
  timeRemaining: number;
  questions: Record<string, QuestionStatus>;
}

export interface ValidationResult {
  description: string;
  passed: boolean;
  expected: string;
  actual: string;
}

export interface ValidationResponse {
  questionId: string;
  passed: boolean;
  results: ValidationResult[];
}

export interface QuestionResultDetail {
  id: string;
  title: string;
  category: string;
  difficulty: string;
  weight: number;
  context: string;
  task: string;
  guide?: string;
  hint?: string;
  solution?: string;
  attempted: boolean;
  passed: boolean;
}

export interface CategoryScore {
  category: string;
  earned: number;
  total: number;
  score: number;
}

export interface ExamResult {
  finished: boolean;
  score: number;
  total: number;
  earned: number;
  passScore: number;
  questions: QuestionResultDetail[];
  categories: CategoryScore[];
}

export interface Prerequisites {
  docker: boolean;
  dockerErr?: string;
  kind: boolean;
  kindErr?: string;
  kubectl: boolean;
  kubectlErr?: string;
}

export interface ClusterStatus {
  running: boolean;
  healthy: boolean;
  state: 'healthy' | 'unhealthy' | 'not_found';
  nodes: string[];
  name: string;
}

export interface AttemptSummary {
  id: string;
  examId: string;
  examName: string;
  date: string;
  score: number;
  passScore: number;
  passed: boolean;
  earned: number;
  total: number;
}

export interface AttemptRecord {
  id: string;
  examId: string;
  examName: string;
  date: string;
  score: number;
  earned: number;
  total: number;
  passScore: number;
  passed: boolean;
  duration: number;
  questions: QuestionResultDetail[];
  categories: CategoryScore[];
}
