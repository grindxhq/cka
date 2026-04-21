package service

import "github.com/grindxhq/cka/internal/cluster"

// ClusterService exposes Kind cluster management to the frontend.
type ClusterService struct {
	manager *cluster.Manager
}

func NewClusterService(cm *cluster.Manager) *ClusterService {
	return &ClusterService{manager: cm}
}

// ClusterStatusResponse is the shape returned to the frontend.
type ClusterStatusResponse struct {
	Running bool     `json:"running"`
	Healthy bool     `json:"healthy"`
	State   string   `json:"state"` // "healthy", "unhealthy", "not_found"
	Nodes   []string `json:"nodes"`
	Name    string   `json:"name"`
}

// GetStatus returns the cluster status including health info.
func (s *ClusterService) GetStatus() (*ClusterStatusResponse, error) {
	state, nodes, err := s.manager.HealthCheck()
	if err != nil {
		return nil, errCluster(err.Error())
	}

	stateStr := "not_found"
	switch state {
	case cluster.ClusterHealthy:
		stateStr = "healthy"
	case cluster.ClusterUnhealthy:
		stateStr = "unhealthy"
	}

	return &ClusterStatusResponse{
		Running: state != cluster.ClusterNotFound,
		Healthy: state == cluster.ClusterHealthy,
		State:   stateStr,
		Nodes:   nodes,
		Name:    "cka-mock",
	}, nil
}

// GetPrerequisites checks for docker, kind, kubectl.
func (s *ClusterService) GetPrerequisites() cluster.Prerequisites {
	return cluster.CheckPrerequisites()
}

// Create creates the Kind cluster.
func (s *ClusterService) Create() error {
	if err := s.manager.Create(); err != nil {
		return errCluster(err.Error())
	}
	return nil
}

// Delete tears down the Kind cluster.
func (s *ClusterService) Delete() error {
	if err := s.manager.Delete(); err != nil {
		return errCluster(err.Error())
	}
	return nil
}
