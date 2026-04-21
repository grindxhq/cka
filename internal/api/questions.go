package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/grindxhq/cka/internal/question"
)

type QuestionsHandler struct {
	store *question.Store
}

func NewQuestionsHandler(store *question.Store) *QuestionsHandler {
	return &QuestionsHandler{store: store}
}

// List returns all questions as summaries.
func (h *QuestionsHandler) List(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.store.Summaries())
}

// Get returns a single question by ID (task + metadata, no validation rules).
func (h *QuestionsHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	q, ok := h.store.Get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "question not found"})
		return
	}

	// Return question detail (without validation rules — those are internal)
	resp := map[string]interface{}{
		"id":         q.ID,
		"title":      q.Title,
		"category":   q.Category,
		"difficulty": q.Difficulty,
		"weight":     q.Weight,
		"context":    q.Context,
		"task":       q.Task,
		"hint":       q.Hint,
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
