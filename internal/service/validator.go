package service

import (
	"github.com/grindxhq/cka/internal/cluster"
	"github.com/grindxhq/cka/internal/exam"
	"github.com/grindxhq/cka/internal/question"
	"github.com/grindxhq/cka/internal/validator"
)

// ValidatorService runs validation rules for questions.
type ValidatorService struct {
	store   *question.Store
	state   *exam.State
	cluster *cluster.Manager
}

func NewValidatorService(store *question.Store, state *exam.State, cm *cluster.Manager) *ValidatorService {
	return &ValidatorService{store: store, state: state, cluster: cm}
}

// ValidationResponse is the shape returned to the frontend.
type ValidationResponse struct {
	QuestionID string                      `json:"questionId"`
	Passed     bool                        `json:"passed"`
	Results    []question.ValidationResult `json:"results"`
}

// ValidateQuestion runs validation rules for a question.
func (s *ValidatorService) ValidateQuestion(id string) (*ValidationResponse, error) {
	// Check cluster health first
	running, _, _ := s.cluster.Status()
	if !running {
		return nil, errCluster("cluster is not running — restart the exam or create a new cluster")
	}

	q, ok := s.store.Get(id)
	if !ok {
		return nil, errNotFound("question not found: " + id)
	}

	results, allPassed := validator.Validate(q.Validation, s.cluster.Kubeconfig(), q.Context)

	// Update exam state
	s.state.SetQuestionResult(id, allPassed)

	return &ValidationResponse{
		QuestionID: id,
		Passed:     allPassed,
		Results:    results,
	}, nil
}
