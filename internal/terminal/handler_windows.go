//go:build windows

package terminal

import (
	"io"
	"log"
	"net/http"
	"os/exec"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/grindxhq/cka/internal/cluster"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Handler returns a WebSocket handler that docker-execs into the exam
// container using stdin/stdout piping (no PTY on Windows).
func Handler(cm *cluster.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("websocket upgrade: %v", err)
			return
		}
		defer conn.Close()

		// Verify cluster is healthy before opening a shell.
		var clusterReady bool
		for attempt := 0; attempt < 10; attempt++ {
			state, _, _ := cm.HealthCheck()
			if state == cluster.ClusterHealthy {
				clusterReady = true
				break
			}
			if state == cluster.ClusterNotFound {
				break
			}
			if attempt == 0 {
				conn.WriteMessage(websocket.BinaryMessage,
					[]byte("\r\n\x1b[33mWaiting for cluster to become ready...\x1b[0m\r\n"))
			}
			time.Sleep(3 * time.Second)
		}
		if !clusterReady {
			msg := "\r\n\x1b[31mError: Kind cluster is not healthy. Try restarting the exam.\x1b[0m\r\n"
			conn.WriteMessage(websocket.BinaryMessage, []byte(msg))
			return
		}

		// docker exec into the container without -t (no TTY on Windows).
		// We use -i for interactive stdin and pipe stdout/stderr.
		containerName := cm.ContainerName()
		cmd := exec.Command("docker", "exec",
			"-i",
			"-e", "KUBECONFIG=/root/.kube/config",
			"-e", "TERM=xterm-256color",
			containerName,
			"bash",
		)

		stdin, err := cmd.StdinPipe()
		if err != nil {
			log.Printf("docker exec stdin pipe: %v", err)
			errMsg := "\r\n\x1b[31mError: Could not attach to container: " + err.Error() + "\x1b[0m\r\n"
			conn.WriteMessage(websocket.BinaryMessage, []byte(errMsg))
			return
		}

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			log.Printf("docker exec stdout pipe: %v", err)
			errMsg := "\r\n\x1b[31mError: Could not attach to container: " + err.Error() + "\x1b[0m\r\n"
			conn.WriteMessage(websocket.BinaryMessage, []byte(errMsg))
			return
		}

		cmd.Stderr = cmd.Stdout // merge stderr into stdout

		if err := cmd.Start(); err != nil {
			log.Printf("docker exec start: %v", err)
			errMsg := "\r\n\x1b[31mError: Could not start container shell: " + err.Error() + "\x1b[0m\r\n"
			conn.WriteMessage(websocket.BinaryMessage, []byte(errMsg))
			return
		}
		defer func() {
			stdin.Close()
			cmd.Process.Kill()
			cmd.Wait()
		}()

		var wg sync.WaitGroup

		// stdout → websocket
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 4096)
			for {
				n, err := stdout.Read(buf)
				if err != nil {
					if err != io.EOF {
						log.Printf("stdout read error: %v", err)
					}
					return
				}
				if err := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
					return
				}
			}
		}()

		// websocket → stdin (resize messages are ignored on Windows — no PTY)
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				break
			}
			if _, err := stdin.Write(msg); err != nil {
				break
			}
		}

		wg.Wait()
	}
}
