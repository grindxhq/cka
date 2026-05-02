package question

// Exam represents a complete exam session loaded from an exam.yaml file.
// Each exam has its own set of questions and cluster requirements.
type Exam struct {
	ID          string          `yaml:"id" json:"id"`
	Name        string          `yaml:"name" json:"name"`
	Description string          `yaml:"description" json:"description"`
	Duration    int             `yaml:"duration" json:"duration"` // seconds
	Difficulty  string          `yaml:"difficulty" json:"difficulty"`
	PassScore   int             `yaml:"passScore" json:"passScore"` // percentage
	Clusters    []ClusterConfig `yaml:"clusters" json:"clusters"`
	Tags        []string        `yaml:"tags,omitempty" json:"tags,omitempty"`
}

// ClusterConfig defines a Kind cluster to create for an exam.
type ClusterConfig struct {
	Name         string `yaml:"name" json:"name"`
	Nodes        int    `yaml:"nodes" json:"nodes"` // total nodes (1 = single control-plane)
	Workers      int    `yaml:"workers" json:"workers"`
	ControlPlane int    `yaml:"controlPlane" json:"controlPlane"`
}

// ExamSummary is the lightweight version returned in list endpoints.
type ExamSummary struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Duration    int             `json:"duration"`
	Difficulty  string          `json:"difficulty"`
	PassScore   int             `json:"passScore"`
	Clusters    []ClusterConfig `json:"clusters"`
	Tags        []string        `json:"tags,omitempty"`
	QuestionCount int           `json:"questionCount"`
	TotalWeight   int           `json:"totalWeight"`
}

// Question represents a single CKA exam question loaded from YAML.
type Question struct {
	ID         string           `yaml:"id" json:"id"`
	Title      string           `yaml:"title" json:"title"`
	Category   string           `yaml:"category" json:"category"`
	Difficulty string           `yaml:"difficulty" json:"difficulty"`
	Weight     int              `yaml:"weight" json:"weight"`
	Context    string           `yaml:"context" json:"context"`
	Task       string           `yaml:"task" json:"task"`
	Guide      string           `yaml:"guide,omitempty" json:"guide,omitempty"`
	Setup      []string         `yaml:"setup,omitempty" json:"-"`
	Validation []ValidationRule `yaml:"validation" json:"-"`
	Hint       string           `yaml:"hint,omitempty" json:"hint,omitempty"`
	Solution   string           `yaml:"solution,omitempty" json:"solution,omitempty"`
}

// QuestionSummary is the lightweight version returned in list endpoints.
type QuestionSummary struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Category   string `json:"category"`
	Difficulty string `json:"difficulty"`
	Weight     int    `json:"weight"`
}

// ValidationRule defines a single check for validating a question answer.
type ValidationRule struct {
	Description string `yaml:"description" json:"description"`
	Command     string `yaml:"command" json:"command"`
	Expect      string `yaml:"expect" json:"expect"`
	Match       string `yaml:"match" json:"match"` // exact, contains, regex
}

// ValidationResult holds the outcome of running a single validation rule.
type ValidationResult struct {
	Description string `json:"description"`
	Passed      bool   `json:"passed"`
	Expected    string `json:"expected"`
	Actual      string `json:"actual"`
}
