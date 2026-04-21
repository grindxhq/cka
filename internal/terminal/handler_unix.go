//go:build !windows

package terminal

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
	"github.com/grindxhq/cka/internal/cluster"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type resizeMsg struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// Handler returns a WebSocket handler that docker-execs into the exam
// container. When a bastion is available, this is the bastion container
// (CKA-realistic: users start on a jump host and SSH into cluster nodes).
// Otherwise falls back to the primary control-plane container.
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

		// docker exec into the primary control-plane container.
		// The in-container kubeconfig at /root/.kube/config has been
		// prepared with Docker network IPs so kubectl works for all clusters.
		containerName := cm.ContainerName()
		cmd := exec.Command("docker", "exec",
			"-i", "-t",
			"-e", "KUBECONFIG=/root/.kube/config",
			"-e", "TERM=xterm-256color",
			containerName,
			"bash",
		)

		ptmx, err := pty.Start(cmd)
		if err != nil {
			log.Printf("docker exec pty start: %v", err)
			errMsg := "\r\n\x1b[31mError: Could not attach to container: " + err.Error() + "\x1b[0m\r\n"
			conn.WriteMessage(websocket.BinaryMessage, []byte(errMsg))
			return
		}
		defer func() {
			ptmx.Close()
			cmd.Process.Kill()
			cmd.Wait()
		}()

		var wg sync.WaitGroup

		// pty stdout → websocket
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, 4096)
			for {
				n, err := ptmx.Read(buf)
				if err != nil {
					return
				}
				if err := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
					return
				}
			}
		}()

		// websocket → pty stdin (+ handle resize)
		for {
			msgType, msg, err := conn.ReadMessage()
			if err != nil {
				break
			}

			if msgType == websocket.TextMessage {
				var rm resizeMsg
				if json.Unmarshal(msg, &rm) == nil && rm.Type == "resize" {
					pty.Setsize(ptmx, &pty.Winsize{
						Rows: rm.Rows,
						Cols: rm.Cols,
					})
					continue
				}
			}

			if _, err := io.WriteString(ptmx, string(msg)); err != nil {
				break
			}
		}

		wg.Wait()
	}
}
