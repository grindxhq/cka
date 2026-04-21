package service

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// AttemptRecord is a single exam attempt saved to disk.
type AttemptRecord struct {
	ID          string                 `json:"id"`
	ExamID      string                 `json:"examId"`
	ExamName    string                 `json:"examName"`
	Date        string                 `json:"date"`        // ISO 8601
	Score       int                    `json:"score"`       // 0-100
	Earned      int                    `json:"earned"`
	Total       int                    `json:"total"`
	PassScore   int                    `json:"passScore"`
	Passed      bool                   `json:"passed"`
	Duration    int                    `json:"duration"`    // seconds taken
	Questions   []QuestionResultDetail `json:"questions"`
	Categories  []CategoryScore        `json:"categories"`
}

// AttemptSummary is the lightweight row shown in the dashboard list.
type AttemptSummary struct {
	ID        string `json:"id"`
	ExamID    string `json:"examId"`
	ExamName  string `json:"examName"`
	Date      string `json:"date"`
	Score     int    `json:"score"`
	PassScore int    `json:"passScore"`
	Passed    bool   `json:"passed"`
	Earned    int    `json:"earned"`
	Total     int    `json:"total"`
}

// HistoryService persists and retrieves exam attempt history.
type HistoryService struct {
	mu   sync.Mutex
	path string // full path to history.json
}

func NewHistoryService() *HistoryService {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	dir := filepath.Join(home, ".grindxhq", "cka")
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("warning: cannot create history dir %s: %v", dir, err)
	}
	return &HistoryService{path: filepath.Join(dir, "history.json")}
}

// SaveAttempt persists a completed exam attempt.
func (h *HistoryService) SaveAttempt(attempt AttemptRecord) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	records, _ := h.loadUnsafe()
	records = append(records, attempt)
	return h.saveUnsafe(records)
}

// ListAttempts returns all attempts as summaries, most recent first.
func (h *HistoryService) ListAttempts() []AttemptSummary {
	h.mu.Lock()
	defer h.mu.Unlock()

	records, _ := h.loadUnsafe()

	// Sort most recent first
	sort.Slice(records, func(i, j int) bool {
		return records[i].Date > records[j].Date
	})

	summaries := make([]AttemptSummary, len(records))
	for i, r := range records {
		summaries[i] = AttemptSummary{
			ID:        r.ID,
			ExamID:    r.ExamID,
			ExamName:  r.ExamName,
			Date:      r.Date,
			Score:     r.Score,
			PassScore: r.PassScore,
			Passed:    r.Passed,
			Earned:    r.Earned,
			Total:     r.Total,
		}
	}
	return summaries
}

// GetAttempt returns the full detail for a single attempt.
func (h *HistoryService) GetAttempt(id string) (*AttemptRecord, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	records, _ := h.loadUnsafe()
	for _, r := range records {
		if r.ID == id {
			return &r, nil
		}
	}
	return nil, errNotFound("attempt not found: " + id)
}

// DeleteAttempt removes an attempt by ID.
func (h *HistoryService) DeleteAttempt(id string) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	records, _ := h.loadUnsafe()
	filtered := make([]AttemptRecord, 0, len(records))
	found := false
	for _, r := range records {
		if r.ID == id {
			found = true
			continue
		}
		filtered = append(filtered, r)
	}
	if !found {
		return errNotFound("attempt not found: " + id)
	}
	return h.saveUnsafe(filtered)
}

// GenerateAttemptID creates a unique ID for an attempt.
func GenerateAttemptID() string {
	return time.Now().Format("20060102-150405")
}

// ── internal file I/O (caller must hold lock) ──

func (h *HistoryService) loadUnsafe() ([]AttemptRecord, error) {
	data, err := os.ReadFile(h.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var records []AttemptRecord
	if err := json.Unmarshal(data, &records); err != nil {
		log.Printf("warning: corrupt history file, starting fresh: %v", err)
		return nil, nil
	}
	return records, nil
}

func (h *HistoryService) saveUnsafe(records []AttemptRecord) error {
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(h.path, data, 0644)
}
