package question

// DeckTopic is a standalone revision deck for a Kubernetes component or theme.
type DeckTopic struct {
	ID            string         `yaml:"id" json:"id"`
	Title         string         `yaml:"title" json:"title"`
	Description   string         `yaml:"description" json:"description"`
	Component     string         `yaml:"component,omitempty" json:"component,omitempty"`
	Domain        string         `yaml:"domain,omitempty" json:"domain,omitempty"`
	Tags          []string       `yaml:"tags,omitempty" json:"tags,omitempty"`
	Subtopics     []DeckSubtopic `yaml:"subtopics" json:"subtopics"`
	SubtopicCount int            `json:"subtopicCount"`
}

// DeckSubtopic is a single revision section inside a deck topic.
type DeckSubtopic struct {
	ID      string   `yaml:"id" json:"id"`
	Title   string   `yaml:"title" json:"title"`
	Summary string   `yaml:"summary,omitempty" json:"summary,omitempty"`
	File    string   `yaml:"file,omitempty" json:"-"`
	Content string   `json:"content"`
	Tags    []string `yaml:"tags,omitempty" json:"tags,omitempty"`
}

// DeckTopicSummary is the lightweight shape used in deck listings.
type DeckTopicSummary struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Description   string   `json:"description"`
	Component     string   `json:"component,omitempty"`
	Domain        string   `json:"domain,omitempty"`
	Tags          []string `json:"tags,omitempty"`
	SubtopicCount int      `json:"subtopicCount"`
}
