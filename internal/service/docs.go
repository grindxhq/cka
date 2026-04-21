package service

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"

	"github.com/grindxhq/cka/internal/api"
)

// DocsService manages a local HTTP server that acts as a transparent
// reverse proxy for kubernetes.io. The path structure mirrors kubernetes.io
// exactly (e.g. /docs/concepts/pods/ → kubernetes.io/docs/concepts/pods/),
// so relative URLs, Pagefind search, JS imports etc. all work naturally.
//
// Runs on 127.0.0.1:0 (ephemeral port) to avoid blocking the Wails
// webview with slow upstream fetches.
type DocsService struct {
	mu       sync.Mutex
	server   *http.Server
	listener net.Listener
	port     int
}

func NewDocsService() *DocsService {
	return &DocsService{}
}

// Start starts the docs proxy server and returns the port.
func (s *DocsService) Start() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.listener != nil {
		return s.port, nil
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, errInternal("failed to start docs proxy: " + err.Error())
	}

	port := ln.Addr().(*net.TCPAddr).Port

	// Single handler: every request is transparently proxied to kubernetes.io.
	// CORS headers are added for the local Wails webview.
	handler := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if req.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		api.KubeDocsProxy(w, req)
	})

	srv := &http.Server{Handler: handler}
	s.server = srv
	s.listener = ln
	s.port = port

	go func() {
		log.Printf("Docs proxy (kubernetes.io mirror) on 127.0.0.1:%d", port)
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("docs proxy server error: %v", err)
		}
	}()

	return port, nil
}

// Stop shuts down the docs proxy server.
func (s *DocsService) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.server != nil {
		s.server.Close()
		s.server = nil
		s.listener = nil
		s.port = 0
		log.Println("Docs proxy server stopped")
	}
}

// GetDocsProxyURL returns the base URL of the docs proxy for the frontend.
// The frontend uses this as the iframe src origin.
func (s *DocsService) GetDocsProxyURL() (string, error) {
	port, err := s.Start()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("http://127.0.0.1:%d", port), nil
}
