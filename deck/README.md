# Revision Deck

This folder contains the standalone revision system for the app.

It is intentionally separated from `questions/` so the deck can be shipped, versioned, or licensed independently from the exam/question bank.

## Structure

```text
deck/
├── README.md
├── backlog.yaml
└── topics/
    └── <topic-id>/
        ├── topic.yaml
        └── *.md
```

## Conventions

- `topics/<topic-id>/topic.yaml` defines topic metadata and subtopic ordering.
- Each subtopic points to a markdown file inside the same topic folder.
- Topic IDs should be stable and filesystem-safe.
- Subtopic markdown should optimize for first-principles understanding, triage flow, pitfalls, and fast exam execution.

## Separation of Concerns

- `questions/` contains exam sessions and optional question-specific sidecar notes.
- `deck/` contains component/topic-first revision material that does not require running Docker or clusters.
