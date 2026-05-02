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
	decks    []DeckTopic
	deckByID map[string]*DeckTopic

	// Flattened view for backward compat (current exam's questions)
	currentExamID string
	allQuestions   []Question
	byID          map[string]*Question
}

// NewStoreFromFS loads questions and standalone revision decks from an embedded filesystem.
// It expects:
//   - questionsDir/exams/<exam-id>/exam.yaml + question YAMLs
//   - decksDir/<deck-id>/topic.yaml + markdown subtopics
// Falls back to flat questionsDir/*.yaml (legacy single-exam mode).
func NewStoreFromFS(fsys fs.FS, questionsDir, decksDir string) (*Store, error) {
	s := &Store{
		byExamID: make(map[string]*ExamWithQuestions),
		byID:     make(map[string]*Question),
		deckByID: make(map[string]*DeckTopic),
	}

	// Try new exam-based layout first: dir/exams/*/exam.yaml
	examsDir := questionsDir + "/exams"
	entries, err := fs.ReadDir(fsys, examsDir)
	if err == nil && len(entries) > 0 {
		if _, err := s.loadExams(fsys, examsDir, entries); err != nil {
			return nil, err
		}
	} else {
		// Fallback: legacy flat layout (questions/*.yaml)
		if _, err := s.loadLegacy(fsys, questionsDir); err != nil {
			return nil, err
		}
	}

	if err := s.loadDecks(fsys, decksDir); err != nil {
		return nil, err
	}

	return s, nil
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
		if q.Guide == "" {
			if guide, ok := readSidecarMarkdown(fsys, dir+"/"+strings.TrimSuffix(f, ".yaml")+".md"); ok {
				q.Guide = guide
			}
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
		if q.Guide == "" {
			if guide, ok := readSidecarMarkdown(fsys, strings.TrimSuffix(f, ".yaml")+".md"); ok {
				q.Guide = guide
			}
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
	if q.Guide == "" {
		sidecarPath := strings.TrimSuffix(path, ".yaml") + ".md"
		if data, err := os.ReadFile(sidecarPath); err == nil {
			q.Guide = string(data)
		}
	}
	return q, nil
}

func readSidecarMarkdown(fsys fs.FS, path string) (string, bool) {
	data, err := fs.ReadFile(fsys, path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

func (s *Store) loadDecks(fsys fs.FS, decksDir string) error {
	entries, err := fs.ReadDir(fsys, decksDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read decks dir: %w", err)
	}

	var deckDirs []string
	for _, e := range entries {
		if e.IsDir() {
			deckDirs = append(deckDirs, e.Name())
		}
	}
	sort.Strings(deckDirs)

	for _, deckDir := range deckDirs {
		deckPath := decksDir + "/" + deckDir
		topic, err := loadDeckTopicDir(fsys, deckPath)
		if err != nil {
			return fmt.Errorf("load deck %s: %w", deckDir, err)
		}
		s.decks = append(s.decks, *topic)
		s.deckByID[topic.ID] = &s.decks[len(s.decks)-1]
	}

	return nil
}

func loadDeckTopicDir(fsys fs.FS, dir string) (*DeckTopic, error) {
	data, err := fs.ReadFile(fsys, dir+"/topic.yaml")
	if err != nil {
		return nil, fmt.Errorf("read topic.yaml: %w", err)
	}

	var topic DeckTopic
	if err := yaml.Unmarshal(data, &topic); err != nil {
		return nil, fmt.Errorf("parse topic.yaml: %w", err)
	}
	if topic.ID == "" {
		return nil, fmt.Errorf("topic.yaml missing 'id' field")
	}
	if topic.Title == "" {
		return nil, fmt.Errorf("topic.yaml missing 'title' field")
	}

	for i := range topic.Subtopics {
		st := &topic.Subtopics[i]
		if st.ID == "" {
			return nil, fmt.Errorf("subtopic in %s missing 'id' field", dir)
		}
		if st.Title == "" {
			return nil, fmt.Errorf("subtopic %s in %s missing 'title' field", st.ID, dir)
		}
		if st.File == "" {
			st.File = st.ID + ".md"
		}
		content, ok := readSidecarMarkdown(fsys, dir+"/"+st.File)
		if !ok {
			return nil, fmt.Errorf("missing markdown for subtopic %s: %s", st.ID, st.File)
		}
		st.Content = content
	}
	topic.SubtopicCount = len(topic.Subtopics)

	return &topic, nil
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

// Decks returns lightweight summaries of all available revision decks.
func (s *Store) Decks() []DeckTopicSummary {
	out := make([]DeckTopicSummary, len(s.decks))
	for i, d := range s.decks {
		out[i] = DeckTopicSummary{
			ID:            d.ID,
			Title:         d.Title,
			Description:   d.Description,
			Component:     d.Component,
			Domain:        d.Domain,
			Tags:          d.Tags,
			SubtopicCount: len(d.Subtopics),
		}
	}
	return out
}

// GetDeck returns a revision deck by ID.
func (s *Store) GetDeck(id string) (*DeckTopic, bool) {
	d, ok := s.deckByID[id]
	return d, ok
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
