package question

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// ExamWithQuestions holds a loaded exam and its questions.
type ExamWithQuestions struct {
	Exam      Exam
	Questions []Question
}

// Store holds all loaded exams and their questions.
type Store struct {
	exams    []ExamWithQuestions
	byExamID map[string]*ExamWithQuestions

	// Flattened view for backward compat (current exam's questions)
	currentExamID string
	allQuestions   []Question
	byID          map[string]*Question
}

// NewStoreFromFS loads all exams from an embedded filesystem.
// It expects: dir/exams/<exam-id>/exam.yaml + question YAMLs
// Falls back to flat dir//*.yaml (legacy single-exam mode).
func NewStoreFromFS(fsys fs.FS, dir string) (*Store, error) {
	s := &Store{
		byExamID: make(map[string]*ExamWithQuestions),
		byID:     make(map[string]*Question),
	}

	// Try new exam-based layout first: dir/exams/*/exam.yaml
	examsDir := dir + "/exams"
	entries, err := fs.ReadDir(fsys, examsDir)
	if err == nil && len(entries) > 0 {
		return s.loadExams(fsys, examsDir, entries)
	}

	// Fallback: legacy flat layout (questions/*.yaml)
	return s.loadLegacy(fsys, dir)
}

// loadExams loads the new exam-based layout.
func (s *Store) loadExams(fsys fs.FS, examsDir string, entries []fs.DirEntry) (*Store, error) {
	var examDirs []string
	for _, e := range entries {
		if e.IsDir() {
			examDirs = append(examDirs, e.Name())
		}
	}
	sort.Strings(examDirs)

	for _, examDir := range examDirs {
		examPath := examsDir + "/" + examDir
		ew, err := loadExamDir(fsys, examPath)
		if err != nil {
			return nil, fmt.Errorf("load exam %s: %w", examDir, err)
		}
		s.exams = append(s.exams, *ew)
		s.byExamID[ew.Exam.ID] = &s.exams[len(s.exams)-1]
	}

	if len(s.exams) == 0 {
		return nil, fmt.Errorf("no exams found in %s", examsDir)
	}

	// Default to first exam
	s.SelectExam(s.exams[0].Exam.ID)
	return s, nil
}

// loadExamDir loads a single exam directory containing exam.yaml + question YAMLs.
func loadExamDir(fsys fs.FS, dir string) (*ExamWithQuestions, error) {
	// Load exam.yaml
	examData, err := fs.ReadFile(fsys, dir+"/exam.yaml")
	if err != nil {
		return nil, fmt.Errorf("read exam.yaml: %w", err)
	}

	var ex Exam
	if err := yaml.Unmarshal(examData, &ex); err != nil {
		return nil, fmt.Errorf("parse exam.yaml: %w", err)
	}
	if ex.ID == "" {
		return nil, fmt.Errorf("exam.yaml missing 'id' field")
	}

	// Load question YAMLs (everything except exam.yaml)
	var files []string
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".yaml") && e.Name() != "exam.yaml" {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	var questions []Question
	for _, f := range files {
		data, err := fs.ReadFile(fsys, dir+"/"+f)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", f, err)
		}
		var q Question
		if err := yaml.Unmarshal(data, &q); err != nil {
			return nil, fmt.Errorf("parse %s: %w", f, err)
		}
		if q.ID == "" {
			return nil, fmt.Errorf("%s: question missing 'id' field", f)
		}
		questions = append(questions, q)
	}

	return &ExamWithQuestions{Exam: ex, Questions: questions}, nil
}

// loadLegacy loads the old flat question layout for backward compat.
func (s *Store) loadLegacy(fsys fs.FS, dir string) (*Store, error) {
	var files []string
	err := fs.WalkDir(fsys, dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(path, ".yaml") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk questions dir: %w", err)
	}
	sort.Strings(files)

	var questions []Question
	for _, f := range files {
		data, err := fs.ReadFile(fsys, f)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", f, err)
		}
		var q Question
		if err := yaml.Unmarshal(data, &q); err != nil {
			return nil, fmt.Errorf("parse %s: %w", f, err)
		}
		if q.ID == "" {
			return nil, fmt.Errorf("%s: question missing 'id' field", f)
		}
		questions = append(questions, q)
	}

	if len(questions) == 0 {
		return nil, fmt.Errorf("no question files found in %s", dir)
	}

	// Create a synthetic exam wrapping legacy questions
	legacyExam := ExamWithQuestions{
		Exam: Exam{
			ID:          "default",
			Name:        "CKA Mock Exam",
			Description: "Default exam session",
			Duration:    7200,
			Difficulty:  "mixed",
			PassScore:   66,
			Clusters: []ClusterConfig{
				{Name: "cka-mock", ControlPlane: 1, Workers: 2, Nodes: 3},
			},
		},
		Questions: questions,
	}

	s.exams = append(s.exams, legacyExam)
	s.byExamID[legacyExam.Exam.ID] = &s.exams[len(s.exams)-1]
	s.SelectExam("default")
	return s, nil
}

// NewStore loads all YAML questions from the given directory (disk-based).
func NewStore(dir string) (*Store, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return nil, fmt.Errorf("glob questions: %w", err)
	}
	sort.Strings(files)

	s := &Store{
		byExamID: make(map[string]*ExamWithQuestions),
		byID:     make(map[string]*Question),
	}

	var questions []Question
	for _, f := range files {
		q, err := loadQuestion(f)
		if err != nil {
			return nil, fmt.Errorf("load %s: %w", filepath.Base(f), err)
		}
		questions = append(questions, q)
	}

	if len(questions) == 0 {
		return nil, fmt.Errorf("no question files found in %s", dir)
	}

	legacyExam := ExamWithQuestions{
		Exam: Exam{
			ID:          "default",
			Name:        "CKA Mock Exam",
			Description: "Default exam session",
			Duration:    7200,
			Difficulty:  "mixed",
			PassScore:   66,
			Clusters: []ClusterConfig{
				{Name: "cka-mock", ControlPlane: 1, Workers: 2, Nodes: 3},
			},
		},
		Questions: questions,
	}

	s.exams = append(s.exams, legacyExam)
	s.byExamID["default"] = &s.exams[0]
	s.SelectExam("default")
	return s, nil
}

func loadQuestion(path string) (Question, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Question{}, err
	}
	var q Question
	if err := yaml.Unmarshal(data, &q); err != nil {
		return Question{}, err
	}
	if q.ID == "" {
		return Question{}, fmt.Errorf("question missing 'id' field")
	}
	return q, nil
}

// --- Exam access ---

// Exams returns summaries of all available exams.
func (s *Store) Exams() []ExamSummary {
	out := make([]ExamSummary, len(s.exams))
	for i, ew := range s.exams {
		totalWeight := 0
		for _, q := range ew.Questions {
			totalWeight += q.Weight
		}
		out[i] = ExamSummary{
			ID:            ew.Exam.ID,
			Name:          ew.Exam.Name,
			Description:   ew.Exam.Description,
			Duration:      ew.Exam.Duration,
			Difficulty:    ew.Exam.Difficulty,
			PassScore:     ew.Exam.PassScore,
			Clusters:      ew.Exam.Clusters,
			Tags:          ew.Exam.Tags,
			QuestionCount: len(ew.Questions),
			TotalWeight:   totalWeight,
		}
	}
	return out
}

// GetExam returns an exam by ID.
func (s *Store) GetExam(id string) (*ExamWithQuestions, bool) {
	ew, ok := s.byExamID[id]
	return ew, ok
}

// SelectExam switches the active exam (updates the flattened question view).
func (s *Store) SelectExam(examID string) bool {
	ew, ok := s.byExamID[examID]
	if !ok {
		return false
	}
	s.currentExamID = examID
	s.allQuestions = ew.Questions
	s.byID = make(map[string]*Question, len(ew.Questions))
	for i := range ew.Questions {
		s.byID[ew.Questions[i].ID] = &ew.Questions[i]
	}
	return true
}

// CurrentExam returns the currently selected exam.
func (s *Store) CurrentExam() *Exam {
	if ew, ok := s.byExamID[s.currentExamID]; ok {
		return &ew.Exam
	}
	return nil
}

// --- Question access (uses current exam) ---

// All returns all questions for the current exam.
func (s *Store) All() []Question {
	return s.allQuestions
}

// Get returns a question by ID from the current exam.
func (s *Store) Get(id string) (*Question, bool) {
	q, ok := s.byID[id]
	return q, ok
}

// Summaries returns lightweight summaries of current exam's questions.
func (s *Store) Summaries() []QuestionSummary {
	out := make([]QuestionSummary, len(s.allQuestions))
	for i, q := range s.allQuestions {
		out[i] = QuestionSummary{
			ID:         q.ID,
			Title:      q.Title,
			Category:   q.Category,
			Difficulty: q.Difficulty,
			Weight:     q.Weight,
		}
	}
	return out
}
