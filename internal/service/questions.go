package service

import "github.com/grindxhq/cka/internal/question"

// QuestionService exposes question data to the Wails frontend.
type QuestionService struct {
	store *question.Store
}

func NewQuestionService(store *question.Store) *QuestionService {
	return &QuestionService{store: store}
}

// ListExams returns summaries of all available exam sessions.
func (s *QuestionService) ListExams() []question.ExamSummary {
	return s.store.Exams()
}

// ListQuestions returns all questions as summaries for the current exam.
func (s *QuestionService) ListQuestions() []question.QuestionSummary {
	return s.store.Summaries()
}

// QuestionDetailResponse is the shape returned to the frontend (no validation rules).
type QuestionDetailResponse struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Category   string `json:"category"`
	Difficulty string `json:"difficulty"`
	Weight     int    `json:"weight"`
	Context    string `json:"context"`
	Task       string `json:"task"`
	Hint       string `json:"hint,omitempty"`
	Solution   string `json:"solution,omitempty"`
}

// GetQuestion returns a single question by ID.
func (s *QuestionService) GetQuestion(id string) (*QuestionDetailResponse, error) {
	q, ok := s.store.Get(id)
	if !ok {
		return nil, errNotFound("question not found: " + id)
	}
	return &QuestionDetailResponse{
		ID:         q.ID,
		Title:      q.Title,
		Category:   q.Category,
		Difficulty: q.Difficulty,
		Weight:     q.Weight,
		Context:    q.Context,
		Task:       q.Task,
		Hint:       q.Hint,
		Solution:   q.Solution,
	}, nil
}
