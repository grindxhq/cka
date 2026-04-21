package main

import (
	"embed"
	"log"

	"github.com/grindxhq/cka/internal/cluster"
	"github.com/grindxhq/cka/internal/exam"
	"github.com/grindxhq/cka/internal/question"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed all:questions
var questionsFS embed.FS

func main() {
	// Load exams and questions from embedded filesystem
	store, err := question.NewStoreFromFS(questionsFS, "questions")
	if err != nil {
		log.Fatalf("Failed to load questions: %v", err)
	}
	log.Printf("Loaded %d exams, %d questions in current exam", len(store.Exams()), len(store.All()))

	state := exam.New()
	cm := cluster.NewManager()
	app := NewApp(store, state, cm)

	err = wails.Run(&options.App{
		Title:     "CKA Mock Exam",
		Width:     1400,
		Height:    900,
		MinWidth:  1024,
		MinHeight: 700,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup:  app.startup,
		OnShutdown: app.shutdown,
		OnDomReady: app.domReady,
		Bind: []interface{}{
			app,
			app.Questions,
			app.Exam,
			app.Cluster,
			app.Validator,
			app.Terminal,
			app.Docs,
			app.History,
		},
	})

	if err != nil {
		log.Fatalf("Wails error: %v", err)
	}
}
