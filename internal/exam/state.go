package exam

import (
	"sync"
	"time"
)

// QuestionStatus tracks per-question validation state.
type QuestionStatus struct {
	Attempted bool `json:"attempted"`
	Passed    bool `json:"passed"`
}

// State manages the in-memory exam session.
type State struct {
	mu        sync.RWMutex
	started   bool
	finished  bool
	startTime time.Time
	duration  time.Duration
	questions map[string]*QuestionStatus
}

// New creates a new exam state.
func New() *State {
	return &State{
		questions: make(map[string]*QuestionStatus),
	}
}

// Start begins the exam with the given duration and question IDs.
func (s *State) Start(duration time.Duration, questionIDs []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.started = true
	s.finished = false
	s.startTime = time.Now()
	s.duration = duration
	s.questions = make(map[string]*QuestionStatus, len(questionIDs))
	for _, id := range questionIDs {
		s.questions[id] = &QuestionStatus{}
	}
}

// Finish ends the exam.
func (s *State) Finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.finished = true
}

// IsStarted returns whether the exam has been started.
func (s *State) IsStarted() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.started
}

// IsFinished returns whether the exam is over.
func (s *State) IsFinished() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.finished || (s.started && time.Since(s.startTime) >= s.duration)
}

// TimeRemaining returns seconds left. Returns 0 if finished or expired.
func (s *State) TimeRemaining() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.started || s.finished {
		return 0
	}
	remaining := s.duration - time.Since(s.startTime)
	if remaining < 0 {
		return 0
	}
	return int(remaining.Seconds())
}

// SetQuestionResult records a validation result for a question.
func (s *State) SetQuestionResult(id string, passed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	qs, ok := s.questions[id]
	if !ok {
		s.questions[id] = &QuestionStatus{Attempted: true, Passed: passed}
		return
	}
	qs.Attempted = true
	if passed {
		qs.Passed = true
	}
}

// StatusResponse is the JSON shape for GET /api/exam/status.
type StatusResponse struct {
	Started       bool                       `json:"started"`
	Finished      bool                       `json:"finished"`
	TimeRemaining int                        `json:"timeRemaining"`
	Questions     map[string]*QuestionStatus `json:"questions"`
}

// Status returns the current exam state as a response.
func (s *State) Status() StatusResponse {
	s.mu.RLock()
	defer s.mu.RUnlock()
	finished := s.finished || (s.started && time.Since(s.startTime) >= s.duration)
	tr := 0
	if s.started && !finished {
		remaining := s.duration - time.Since(s.startTime)
		if remaining > 0 {
			tr = int(remaining.Seconds())
		}
	}
	return StatusResponse{
		Started:       s.started,
		Finished:      finished,
		TimeRemaining: tr,
		Questions:     s.questions,
	}
}
