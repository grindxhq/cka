package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/grindxhq/cka/internal/cluster"
	"github.com/grindxhq/cka/internal/exam"
	"github.com/grindxhq/cka/internal/question"
	"github.com/grindxhq/cka/internal/validator"
)

type ValidateHandler struct {
	store   *question.Store
	state   *exam.State
	cluster *cluster.Manager
}

func NewValidateHandler(store *question.Store, state *exam.State, cm *cluster.Manager) *ValidateHandler {
	return &ValidateHandler{store: store, state: state, cluster: cm}
}

// Validate runs validation rules for a question.
func (h *ValidateHandler) Validate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	q, ok := h.store.Get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "question not found"})
		return
	}

	results, allPassed := validator.Validate(q.Validation, h.cluster.Kubeconfig())

	// Update exam state
	h.state.SetQuestionResult(id, allPassed)

	resp := map[string]interface{}{
		"questionId": id,
		"passed":     allPassed,
		"results":    results,
	}
	writeJSON(w, http.StatusOK, resp)
}
