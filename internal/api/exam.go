package api

import (
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"time"

	"github.com/grindxhq/cka/internal/cluster"
	"github.com/grindxhq/cka/internal/exam"
	"github.com/grindxhq/cka/internal/question"
)

type ExamHandler struct {
	state   *exam.State
	store   *question.Store
	cluster *cluster.Manager
}

func NewExamHandler(state *exam.State, store *question.Store, cm *cluster.Manager) *ExamHandler {
	return &ExamHandler{state: state, store: store, cluster: cm}
}

type startRequest struct {
	Duration int `json:"duration"` // seconds
}

// Start begins the exam: creates Kind cluster if needed, starts timer.
func (h *ExamHandler) Start(w http.ResponseWriter, r *http.Request) {
	if h.state.IsStarted() && !h.state.IsFinished() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "exam already in progress"})
		return
	}

	var req startRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Duration <= 0 {
		req.Duration = 7200 // default 2 hours
	}

	// Create Kind cluster if not running
	if err := h.cluster.Create(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "failed to create cluster: " + err.Error(),
		})
		return
	}

	// Set up CKA-friendly environment inside the container
	if err := h.cluster.PrepareContainer(); err != nil {
		log.Printf("warning: failed to prepare container: %v", err)
	}

	// Run setup commands for all questions
	kubeconfig := h.cluster.Kubeconfig()
	for _, q := range h.store.All() {
		for _, cmd := range q.Setup {
			runSetupCommand(cmd, kubeconfig)
		}
	}

	// Collect question IDs
	questions := h.store.All()
	ids := make([]string, len(questions))
	for i, q := range questions {
		ids[i] = q.ID
	}

	h.state.Start(time.Duration(req.Duration)*time.Second, ids)

	writeJSON(w, http.StatusOK, map[string]string{"status": "started"})
}

func runSetupCommand(command, kubeconfig string) {
	cmd := exec.Command("sh", "-c", command)
	cmd.Env = append(cmd.Environ(), "KUBECONFIG="+kubeconfig)
	_ = cmd.Run()
}

// Status returns the current exam state.
func (h *ExamHandler) Status(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.state.Status())
}

// Finish ends the exam and returns final results.
func (h *ExamHandler) Finish(w http.ResponseWriter, r *http.Request) {
	h.state.Finish()

	// Calculate score
	status := h.state.Status()
	totalWeight := 0
	earnedWeight := 0
	for _, q := range h.store.All() {
		totalWeight += q.Weight
		if qs, ok := status.Questions[q.ID]; ok && qs.Passed {
			earnedWeight += q.Weight
		}
	}

	score := 0
	if totalWeight > 0 {
		score = (earnedWeight * 100) / totalWeight
	}

	resp := map[string]interface{}{
		"finished":  true,
		"score":     score,
		"total":     totalWeight,
		"earned":    earnedWeight,
		"questions": status.Questions,
	}
	writeJSON(w, http.StatusOK, resp)
}
