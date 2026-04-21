package main

import (
	"context"
	"log"
	"strings"

	"github.com/grindxhq/cka/internal/cluster"
	"github.com/grindxhq/cka/internal/exam"
	"github.com/grindxhq/cka/internal/question"
	"github.com/grindxhq/cka/internal/service"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// App holds the Wails application lifecycle and references to services.
type App struct {
	ctx context.Context

	store   *question.Store
	state   *exam.State
	cluster *cluster.Manager

	// Services (bound to frontend via Wails)
	Questions *service.QuestionService
	Exam      *service.ExamService
	Cluster   *service.ClusterService
	Validator *service.ValidatorService
	Terminal  *service.TerminalService
	Docs      *service.DocsService
	History   *service.HistoryService
}

// NewApp creates the application with all services wired up.
func NewApp(store *question.Store, state *exam.State, cm *cluster.Manager) *App {
	app := &App{
		store:   store,
		state:   state,
		cluster: cm,
	}

	app.History = service.NewHistoryService()
	app.Questions = service.NewQuestionService(store)
	app.Exam = service.NewExamService(state, store, cm, app.History)
	app.Cluster = service.NewClusterService(cm)
	app.Validator = service.NewValidatorService(store, state, cm)
	app.Terminal = service.NewTerminalService(cm)
	app.Docs = service.NewDocsService()

	return app
}

// startup is called when the Wails app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.Terminal.SetContext(ctx)
	a.Exam.SetContext(ctx)
	log.Printf("CKA Mock Exam ready — %d questions loaded", len(a.store.All()))
}

// shutdown is called when the Wails app is closing.
func (a *App) shutdown(ctx context.Context) {
	// Stop background servers
	a.Terminal.Stop()
	a.Docs.Stop()

	// Optionally clean up cluster — for now we leave it running
	// so the user can restart the app quickly.
	log.Println("CKA Mock Exam shutting down")
}

// domReady is called after the frontend DOM is ready.
func (a *App) domReady(ctx context.Context) {
	// Nothing needed for now
}

// EnterFullscreen puts the window into fullscreen mode (like the real CKA exam).
func (a *App) EnterFullscreen() {
	wailsRuntime.WindowFullscreen(a.ctx)
}

// ExitFullscreen leaves fullscreen mode.
func (a *App) ExitFullscreen() {
	wailsRuntime.WindowUnfullscreen(a.ctx)
}

// OpenInBrowser opens a URL in the user's system browser.
// Only allows kubernetes.io URLs for security.
func (a *App) OpenInBrowser(url string) {
	// Only allow kubernetes.io URLs
	if strings.HasPrefix(url, "https://kubernetes.io/") || url == "https://kubernetes.io" {
		wailsRuntime.BrowserOpenURL(a.ctx, url)
	} else {
		// Default to docs home
		wailsRuntime.BrowserOpenURL(a.ctx, "https://kubernetes.io/docs/")
	}
}
