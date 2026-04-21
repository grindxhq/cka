package service

import "fmt"

// ServiceError is a structured error returned by all service methods.
// Wails serialises this to the frontend so errors are typed, not raw strings.
type ServiceError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *ServiceError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func errNotFound(msg string) error {
	return &ServiceError{Code: "NOT_FOUND", Message: msg}
}

func errBadRequest(msg string) error {
	return &ServiceError{Code: "BAD_REQUEST", Message: msg}
}

func errInternal(msg string) error {
	return &ServiceError{Code: "INTERNAL", Message: msg}
}

func errCluster(msg string) error {
	return &ServiceError{Code: "CLUSTER_ERROR", Message: msg}
}
