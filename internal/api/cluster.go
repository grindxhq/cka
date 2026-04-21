package api

import (
	"net/http"

	"github.com/grindxhq/cka/internal/cluster"
)

type ClusterHandler struct {
	manager *cluster.Manager
}

func NewClusterHandler(m *cluster.Manager) *ClusterHandler {
	return &ClusterHandler{manager: m}
}

// Create creates the Kind cluster.
func (h *ClusterHandler) Create(w http.ResponseWriter, r *http.Request) {
	if err := h.manager.Create(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "created"})
}

// Delete tears down the Kind cluster.
func (h *ClusterHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.manager.Delete(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// Status returns the cluster status.
func (h *ClusterHandler) Status(w http.ResponseWriter, r *http.Request) {
	running, nodes, err := h.manager.Status()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"running": running,
		"nodes":   nodes,
		"name":    "cka-mock",
	})
}

// Prerequisites checks for docker, kind, kubectl.
func (h *ClusterHandler) Prerequisites(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, cluster.CheckPrerequisites())
}
