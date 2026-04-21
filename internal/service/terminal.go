package service

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"

	"github.com/grindxhq/cka/internal/cluster"
	"github.com/grindxhq/cka/internal/terminal"
)

// TerminalService manages a local WebSocket server for the terminal.
// It binds to 127.0.0.1:0 (ephemeral port) so no user-visible port
// is consumed and there's no port conflict risk.
type TerminalService struct {
	cm  *cluster.Manager
	ctx context.Context

	mu       sync.Mutex
	server   *http.Server
	listener net.Listener
	port     int
}

func NewTerminalService(cm *cluster.Manager) *TerminalService {
	return &TerminalService{cm: cm}
}

// SetContext stores the Wails runtime context.
func (s *TerminalService) SetContext(ctx context.Context) {
	s.ctx = ctx
}

// Start starts the local WebSocket terminal server and returns the port.
func (s *TerminalService) Start() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// If already running, return existing port
	if s.listener != nil {
		return s.port, nil
	}

	// Bind to loopback on ephemeral port
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, errInternal("failed to start terminal server: " + err.Error())
	}

	port := ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/terminal", terminal.Handler(s.cm))

	srv := &http.Server{Handler: withCORS(mux)}

	s.server = srv
	s.listener = ln
	s.port = port

	go func() {
		log.Printf("Terminal WebSocket server on 127.0.0.1:%d", port)
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("terminal server error: %v", err)
		}
	}()

	return port, nil
}

// Stop shuts down the terminal server.
func (s *TerminalService) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.server != nil {
		s.server.Close()
		s.server = nil
		s.listener = nil
		s.port = 0
		log.Println("Terminal server stopped")
	}
}

// Port returns the current port (0 if not running).
func (s *TerminalService) Port() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.port
}

// Restart stops and starts the terminal server (useful if shell dies).
func (s *TerminalService) Restart() (int, error) {
	s.Stop()
	return s.Start()
}

// withCORS wraps a handler with permissive CORS for the loopback server.
func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// GetTerminalURL returns the full WebSocket URL for the terminal.
// Convenience method for the frontend.
func (s *TerminalService) GetTerminalURL() (string, error) {
	port, err := s.Start()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("ws://127.0.0.1:%d/ws/terminal", port), nil
}
