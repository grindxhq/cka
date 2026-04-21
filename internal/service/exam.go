package service

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/grindxhq/cka/internal/cluster"
	"github.com/grindxhq/cka/internal/exam"
	"github.com/grindxhq/cka/internal/question"
	"github.com/grindxhq/cka/internal/validator"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ExamService manages the exam lifecycle.
type ExamService struct {
	ctx     context.Context
	state   *exam.State
	store   *question.Store
	cluster *cluster.Manager
	history *HistoryService
}

func NewExamService(state *exam.State, store *question.Store, cm *cluster.Manager, history *HistoryService) *ExamService {
	return &ExamService{state: state, store: store, cluster: cm, history: history}
}

// SetContext stores the Wails app context for emitting events.
func (s *ExamService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// emitProgress sends a progress event to the frontend.
func (s *ExamService) emitProgress(step, message string) {
	s.emitProgressData(step, message, nil)
}

// emitProgressData sends a progress event with optional extra fields.
func (s *ExamService) emitProgressData(step, message string, extra map[string]interface{}) {
	if s.ctx == nil {
		return
	}
	data := map[string]interface{}{
		"step":    step,
		"message": message,
	}
	for k, v := range extra {
		data[k] = v
	}
	wailsRuntime.EventsEmit(s.ctx, "exam:progress", data)
}

// ListExams returns summaries of all available exam sessions.
func (s *ExamService) ListExams() []question.ExamSummary {
	return s.store.Exams()
}

// SelectExam switches the active exam by ID. Must be called before StartExam.
func (s *ExamService) SelectExam(examID string) error {
	if !s.store.SelectExam(examID) {
		return errNotFound("exam not found: " + examID)
	}
	return nil
}

// StartExam begins the exam: creates Kind clusters as needed, runs setup, starts timer.
// duration is in seconds (0 = use exam's default). Emits "exam:progress" events.
func (s *ExamService) StartExam(duration int) error {
	if s.state.IsStarted() && !s.state.IsFinished() {
		return errBadRequest("exam already in progress")
	}

	currentExam := s.store.CurrentExam()
	if currentExam == nil {
		return errBadRequest("no exam selected")
	}

	if duration <= 0 {
		duration = currentExam.Duration
	}
	if duration <= 0 {
		duration = 7200 // default 2 hours
	}

	// ── Step 1: Set up all clusters the exam requires ──
	totalClusters := len(currentExam.Clusters)
	clusterNames := make([]string, totalClusters)
	for i, cl := range currentExam.Clusters {
		clusterNames[i] = cl.Name
	}

	s.emitProgressData("cluster", fmt.Sprintf("Setting up %d cluster(s)...", totalClusters), map[string]interface{}{
		"totalClusters": totalClusters,
		"clusterNames":  clusterNames,
		"phase":         "init",
	})

	err := s.cluster.SetupClusters(currentExam.Clusters, func(clusterName, message string) {
		extra := map[string]interface{}{
			"totalClusters": totalClusters,
			"clusterNames":  clusterNames,
		}
		if clusterName != "" {
			extra["clusterName"] = clusterName
		}
		s.emitProgressData("cluster", message, extra)
	})
	if err != nil {
		s.emitProgress("error", "Cluster setup failed: "+err.Error())
		return errCluster("failed to set up clusters: " + err.Error())
	}

	// ── Step 2: Prepare CKA-friendly environment in all containers ──
	s.emitProgress("prepare", "Setting up CKA environment (aliases, completions)...")
	if err := s.cluster.PrepareContainer(); err != nil {
		log.Printf("warning: failed to prepare container: %v", err)
		s.emitProgress("prepare", "Warning: CKA environment setup had issues (non-fatal)")
	} else {
		s.emitProgress("prepare", "CKA environment ready")
	}

	// ── Step 3: Run setup commands for all questions ──
	kubeconfig := s.cluster.Kubeconfig()
	questions := s.store.All()
	var setupErrors []string

	for i, q := range questions {
		if len(q.Setup) == 0 {
			continue
		}
		s.emitProgress("setup", fmt.Sprintf("Setting up question %d/%d: %s", i+1, len(questions), q.Title))
		for _, cmdStr := range q.Setup {
			if err := runSetupCommand(cmdStr, kubeconfig); err != nil {
				errMsg := fmt.Sprintf("setup for %q: %v", q.ID, err)
				log.Printf("warning: %s", errMsg)
				setupErrors = append(setupErrors, errMsg)
			}
		}
	}

	if len(setupErrors) > 0 {
		s.emitProgress("setup", fmt.Sprintf("Setup completed with %d warning(s)", len(setupErrors)))
		log.Printf("Setup warnings:\n  %s", strings.Join(setupErrors, "\n  "))
	} else {
		s.emitProgress("setup", "All question setups completed")
	}

	// ── Step 4: Start the exam timer ──
	ids := make([]string, len(questions))
	for i, q := range questions {
		ids[i] = q.ID
	}

	s.state.Start(time.Duration(duration)*time.Second, ids)
	s.emitProgress("ready", "Exam started! Good luck!")
	return nil
}

func runSetupCommand(command, kubeconfig string) error {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", command)
	} else {
		cmd = exec.Command("sh", "-c", command)
	}
	cmd.Env = append(cmd.Environ(), "KUBECONFIG="+kubeconfig)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// GetStatus returns the current exam state.
func (s *ExamService) GetStatus() exam.StatusResponse {
	return s.state.Status()
}

// QuestionResultDetail holds per-question result data for the review screen.
type QuestionResultDetail struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Category   string `json:"category"`
	Difficulty string `json:"difficulty"`
	Weight     int    `json:"weight"`
	Context    string `json:"context"`
	Task       string `json:"task"`
	Hint       string `json:"hint,omitempty"`
	Solution   string `json:"solution,omitempty"`
	Attempted  bool   `json:"attempted"`
	Passed     bool   `json:"passed"`
}

// CategoryScore holds aggregated scores per category.
type CategoryScore struct {
	Category string `json:"category"`
	Earned   int    `json:"earned"`
	Total    int    `json:"total"`
	Score    int    `json:"score"` // percentage
}

// ExamResultResponse is the final exam result.
type ExamResultResponse struct {
	Finished   bool                    `json:"finished"`
	Score      int                     `json:"score"`
	Total      int                     `json:"total"`
	Earned     int                     `json:"earned"`
	PassScore  int                     `json:"passScore"`
	Questions  []QuestionResultDetail  `json:"questions"`
	Categories []CategoryScore         `json:"categories"`
}

// FinishExam ends the exam and returns final results.
// It validates ALL questions against the live cluster state before scoring.
func (s *ExamService) FinishExam() ExamResultResponse {
	s.state.Finish()

	questions := s.store.All()
	kubeconfig := s.cluster.Kubeconfig()

	// ── Validate every question against the live cluster ──
	s.emitProgress("grading", fmt.Sprintf("Grading %d questions...", len(questions)))

	for i, q := range questions {
		if len(q.Validation) == 0 {
			continue
		}
		s.emitProgress("grading", fmt.Sprintf("Grading question %d/%d: %s", i+1, len(questions), q.Title))
		_, allPassed := validator.Validate(q.Validation, kubeconfig)
		s.state.SetQuestionResult(q.ID, allPassed)
	}

	s.emitProgress("grading", "Grading complete!")

	// ── Now compute scores from freshly-validated state ──
	status := s.state.Status()
	totalWeight := 0
	earnedWeight := 0

	var questionResults []QuestionResultDetail
	categoryTotals := make(map[string]int)
	categoryEarned := make(map[string]int)
	categoryOrder := []string{}

	for _, q := range questions {
		totalWeight += q.Weight
		attempted := false
		passed := false
		if qs, ok := status.Questions[q.ID]; ok {
			attempted = qs.Attempted
			passed = qs.Passed
		}
		if passed {
			earnedWeight += q.Weight
		}

		questionResults = append(questionResults, QuestionResultDetail{
			ID:         q.ID,
			Title:      q.Title,
			Category:   q.Category,
			Difficulty: q.Difficulty,
			Weight:     q.Weight,
			Context:    q.Context,
			Task:       q.Task,
			Hint:       q.Hint,
			Solution:   q.Solution,
			Attempted:  attempted,
			Passed:     passed,
		})

		if _, seen := categoryTotals[q.Category]; !seen {
			categoryOrder = append(categoryOrder, q.Category)
		}
		categoryTotals[q.Category] += q.Weight
		if passed {
			categoryEarned[q.Category] += q.Weight
		}
	}

	score := 0
	if totalWeight > 0 {
		score = (earnedWeight * 100) / totalWeight
	}

	passScore := 66
	if ex := s.store.CurrentExam(); ex != nil && ex.PassScore > 0 {
		passScore = ex.PassScore
	}

	var categories []CategoryScore
	for _, cat := range categoryOrder {
		catScore := 0
		if categoryTotals[cat] > 0 {
			catScore = (categoryEarned[cat] * 100) / categoryTotals[cat]
		}
		categories = append(categories, CategoryScore{
			Category: cat,
			Earned:   categoryEarned[cat],
			Total:    categoryTotals[cat],
			Score:    catScore,
		})
	}

	result := ExamResultResponse{
		Finished:   true,
		Score:      score,
		Total:      totalWeight,
		Earned:     earnedWeight,
		PassScore:  passScore,
		Questions:  questionResults,
		Categories: categories,
	}

	// Auto-save attempt to history
	if s.history != nil {
		examName := ""
		examID := ""
		if ex := s.store.CurrentExam(); ex != nil {
			examName = ex.Name
			examID = ex.ID
		}
		attempt := AttemptRecord{
			ID:         GenerateAttemptID(),
			ExamID:     examID,
			ExamName:   examName,
			Date:       time.Now().UTC().Format(time.RFC3339),
			Score:      score,
			Earned:     earnedWeight,
			Total:      totalWeight,
			PassScore:  passScore,
			Passed:     score >= passScore,
			Duration:   0, // TODO: track actual duration
			Questions:  questionResults,
			Categories: categories,
		}
		if err := s.history.SaveAttempt(attempt); err != nil {
			log.Printf("warning: failed to save attempt to history: %v", err)
		}
	}

	return result
}
