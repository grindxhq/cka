package validator

import (
	"context"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/grindxhq/cka/internal/question"
)

const defaultTimeout = 5 * time.Second

// Validate runs all validation rules for a question and returns results.
func Validate(rules []question.ValidationRule, kubeconfig string) ([]question.ValidationResult, bool) {
	results := make([]question.ValidationResult, len(rules))
	allPassed := true

	for i, rule := range rules {
		actual, err := runCommand(rule.Command, kubeconfig)
		if err != nil {
			results[i] = question.ValidationResult{
				Description: rule.Description,
				Passed:      false,
				Expected:    rule.Expect,
				Actual:      "error: " + err.Error(),
			}
			allPassed = false
			continue
		}

		actual = strings.TrimSpace(actual)
		passed := matchOutput(actual, rule.Expect, rule.Match)
		if !passed {
			allPassed = false
		}

		results[i] = question.ValidationResult{
			Description: rule.Description,
			Passed:      passed,
			Expected:    rule.Expect,
			Actual:      actual,
		}
	}

	return results, allPassed
}

func runCommand(command, kubeconfig string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), defaultTimeout)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", command)
	}
	if kubeconfig != "" {
		cmd.Env = append(cmd.Environ(), "KUBECONFIG="+kubeconfig)
	}

	out, err := cmd.CombinedOutput()
	return string(out), err
}

func matchOutput(actual, expected, matchType string) bool {
	switch matchType {
	case "contains":
		return strings.Contains(actual, expected)
	case "regex":
		matched, err := regexp.MatchString(expected, actual)
		return err == nil && matched
	case "not-contains":
		return !strings.Contains(actual, expected)
	default: // "exact"
		return actual == expected
	}
}
