package server

import (
	"embed"
	"io/fs"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/grindxhq/cka/internal/api"
	"github.com/grindxhq/cka/internal/cluster"
	"github.com/grindxhq/cka/internal/exam"
	"github.com/grindxhq/cka/internal/question"
	"github.com/grindxhq/cka/internal/terminal"
)

// New creates the HTTP server with all routes.
func New(store *question.Store, state *exam.State, cm *cluster.Manager, distFS embed.FS) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(corsMiddleware)

	qh := api.NewQuestionsHandler(store)
	eh := api.NewExamHandler(state, store, cm)
	vh := api.NewValidateHandler(store, state, cm)
	ch := api.NewClusterHandler(cm)

	// API routes
	r.Route("/api", func(r chi.Router) {
		r.Get("/questions", qh.List)
		r.Get("/questions/{id}", qh.Get)

		r.Post("/exam/start", eh.Start)
		r.Get("/exam/status", eh.Status)
		r.Post("/exam/finish", eh.Finish)

		r.Post("/validate/{id}", vh.Validate)

		r.Get("/docs/proxy/*", api.KubeDocsProxy)

		r.Post("/cluster/create", ch.Create)
		r.Delete("/cluster/delete", ch.Delete)
		r.Get("/cluster/status", ch.Status)
		r.Get("/cluster/prerequisites", ch.Prerequisites)
	})

	// WebSocket terminal — execs into Kind container, not host
	r.Get("/ws/terminal", terminal.Handler(cm))

	// Redirect bare kubernetes.io paths to the docs proxy.
	// Inside the iframe, JavaScript-based navigation (e.g. Pagefind search)
	// may set window.location to "/docs/..." without the proxy prefix.
	// Without this redirect the SPA catch-all would serve index.html (the
	// exam page) instead of the proxied k8s docs.
	r.Get("/docs/*", docsRedirect)

	// Serve frontend
	distContent, err := fs.Sub(distFS, "dist")
	if err == nil {
		fileServer := http.FileServer(http.FS(distContent))
		r.Handle("/*", spaHandler(distContent, fileServer))
	}

	return r
}

// spaHandler wraps a file server to serve index.html for non-file paths (SPA routing).
func spaHandler(fsys fs.FS, fileServer http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" {
			path = "index.html"
		} else if len(path) > 0 && path[0] == '/' {
			path = path[1:]
		}
		// Try to open the file; if it doesn't exist, serve index.html
		if _, err := fs.Stat(fsys, path); err != nil {
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
}

// docsRedirect catches bare /docs/* requests that leak out of the proxied
// iframe (typically from JavaScript navigation like Pagefind search) and
// redirects them into the docs proxy so they render correctly.
func docsRedirect(w http.ResponseWriter, r *http.Request) {
	target := "/api/docs/proxy/kubernetes.io" + r.URL.Path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	http.Redirect(w, r, target, http.StatusTemporaryRedirect)
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}
