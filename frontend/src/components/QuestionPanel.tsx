import { useState, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useExam } from '../hooks/useExam';
import { useTheme, colors } from '../hooks/useTheme';

function ContextSwitchBlock({ context, c, isDark }: { context: string; c: ReturnType<typeof colors>; isDark: boolean }) {
  const [copied, setCopied] = useState(false);
  const command = `kubectl config use-context ${context}`;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);

  return (
    <div style={{
      marginBottom: '16px',
      padding: '10px 14px',
      background: isDark ? '#1c1c21' : '#ecfeff',
      border: `1px solid ${isDark ? '#2e2e35' : '#a5f3fc'}`,
      borderLeft: '3px solid #06b6d4',
      borderRadius: '6px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        <span style={{
          fontSize: '11px', color: isDark ? '#a1a1aa' : '#71717a',
          fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
          flexShrink: 0,
        }}>
          Context
        </span>
        <code style={{
          fontSize: '13px',
          color: '#06b6d4',
          fontWeight: 600,
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {command}
        </code>
      </div>
      <button
        onClick={handleCopy}
        title="Copy to clipboard"
        style={{
          padding: '3px 10px',
          background: copied ? '#16a34a' : (isDark ? '#2e2e35' : '#cffafe'),
          color: copied ? 'white' : (isDark ? '#67e8f9' : '#0e7490'),
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: 600,
          flexShrink: 0,
          transition: 'all 0.15s',
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

export function QuestionPanel() {
  const {
    currentQuestion, validateCurrent, validationResult,
    loading, mode, flaggedQuestions, toggleFlag, currentQuestionId,
  } = useExam();
  const { isDark } = useTheme();
  const c = colors(isDark);
  const [showHint, setShowHint] = useState(false);
  const [showSolution, setShowSolution] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  const isPractice = mode === 'practice';
  const isFlagged = currentQuestionId ? flaggedQuestions.has(currentQuestionId) : false;

  useEffect(() => {
    setShowHint(false);
    setShowSolution(false);
    setShowGuide(false);
  }, [currentQuestionId]);

  if (!currentQuestion) {
    return (
      <div style={{ padding: '24px', color: c.questionMuted }}>
        Select a question to begin.
      </div>
    );
  }

  return (
    <div style={{
      flex: 1,
      padding: '24px 28px',
      overflow: 'auto',
      background: c.questionBg,
      color: c.questionText,
    }}>
      {/* Top row: metadata + flag */}
      <div style={{ marginBottom: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{
          fontSize: '11px',
          padding: '2px 8px',
          borderRadius: '4px',
          background: difficultyColor(currentQuestion.difficulty),
          color: 'white',
          fontWeight: 600,
          textTransform: 'uppercase',
        }}>
          {currentQuestion.difficulty}
        </span>
        <span style={{ fontSize: '12px', color: c.questionMuted }}>
          {currentQuestion.category}
        </span>
        <span style={{ fontSize: '12px', color: c.questionMuted }}>
          Weight: {currentQuestion.weight}%
        </span>

        {/* Flag button */}
        <button
          onClick={() => currentQuestionId && toggleFlag(currentQuestionId)}
          title={isFlagged ? 'Unflag this question' : 'Flag for review'}
          style={{
            marginLeft: 'auto',
            padding: '3px 10px',
            background: isFlagged ? '#f59e0b' : c.btnSecondaryBg,
            color: isFlagged ? 'white' : c.questionMuted,
            border: isFlagged ? '1px solid #f59e0b' : `1px solid ${c.btnSecondaryBorder}`,
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          {isFlagged ? '\u2691' : '\u2690'} {isFlagged ? 'Flagged' : 'Flag'}
        </button>
      </div>

      {/* Title */}
      <h2 style={{ fontSize: '18px', marginBottom: '16px', color: c.questionHeading, fontWeight: 600 }}>
        {currentQuestion.title}
      </h2>

      {/* CKA-style context switch command */}
      {currentQuestion.context && (
        <ContextSwitchBlock context={currentQuestion.context} c={c} isDark={isDark} />
      )}

      {/* Task description */}
      <div className="question-content" style={{
        fontSize: '14px',
        lineHeight: '1.75',
        color: c.questionText,
      }}>
        <style>{`
          .question-content ul,
          .question-content ol {
            padding-left: 28px;
            margin: 8px 0 12px;
          }
          .question-content li {
            margin-bottom: 6px;
            padding-left: 4px;
          }
          .question-content p {
            margin-bottom: 10px;
          }
          .question-content strong {
            color: ${c.questionHeading};
            font-weight: 600;
          }
        `}</style>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code: ({ children, className }) => {
              if (!className) {
                return (
                  <code style={{
                    background: c.codeBg,
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontSize: '13px',
                    color: c.codeText,
                    border: `1px solid ${c.codeBorder}`,
                    fontFamily: "'SF Mono', 'Fira Code', Menlo, Consolas, monospace",
                  }}>
                    {children}
                  </code>
                );
              }
              return <code className={className}>{children}</code>;
            },
            pre: ({ children }) => (
              <pre style={{
                background: '#1c1c21',
                padding: '14px 16px',
                borderRadius: '6px',
                overflow: 'auto',
                fontSize: '13px',
                color: '#fafafa',
                margin: '12px 0',
                fontFamily: "'SF Mono', 'Fira Code', Menlo, Consolas, monospace",
              }}>
                {children}
              </pre>
            ),
          }}
        >
          {currentQuestion.task}
        </ReactMarkdown>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '20px', flexWrap: 'wrap' }}>
        {/* Check Answer — only in Practice mode (real CKA doesn't allow per-question validation) */}
        {isPractice && (
          <button
            onClick={validateCurrent}
            disabled={loading}
            style={{
              padding: '8px 24px',
              background: '#06b6d4',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: loading ? 'wait' : 'pointer',
              fontWeight: 600,
              fontSize: '14px',
            }}
          >
            {loading ? 'Validating...' : 'Check Answer'}
          </button>
        )}

        {/* Hint — only in Practice mode */}
        {isPractice && currentQuestion.hint && (
          <button
            onClick={() => setShowHint(!showHint)}
            style={{
              padding: '8px 20px',
              background: c.btnSecondaryBg,
              color: c.btnSecondaryText,
              border: `1px solid ${c.btnSecondaryBorder}`,
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            {showHint ? 'Hide Hint' : 'Show Hint'}
          </button>
        )}

        {/* Study deck — rich markdown notes for practice mode */}
        {isPractice && currentQuestion.guide && (
          <button
            onClick={() => setShowGuide(!showGuide)}
            style={{
              padding: '8px 20px',
              background: showGuide ? '#0e7490' : c.btnSecondaryBg,
              color: showGuide ? 'white' : c.btnSecondaryText,
              border: showGuide ? '1px solid #0e7490' : `1px solid ${c.btnSecondaryBorder}`,
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            {showGuide ? 'Hide Study Deck' : 'Open Study Deck'}
          </button>
        )}

        {/* Solution — only in Practice mode, after validation */}
        {isPractice && currentQuestion.solution && validationResult && (
          <button
            onClick={() => setShowSolution(!showSolution)}
            style={{
              padding: '8px 20px',
              background: showSolution ? '#16a34a' : c.btnSecondaryBg,
              color: showSolution ? 'white' : c.btnSecondaryText,
              border: showSolution ? '1px solid #16a34a' : `1px solid ${c.btnSecondaryBorder}`,
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            {showSolution ? 'Hide Solution' : 'Show Solution'}
          </button>
        )}
      </div>

      {/* Hint panel — Practice mode only */}
      {isPractice && showHint && currentQuestion.hint && (
        <div style={{
          marginTop: '12px',
          padding: '12px 16px',
          background: c.hintBg,
          borderRadius: '6px',
          borderLeft: `3px solid ${c.hintBorder}`,
          fontSize: '13px',
          color: c.hintText,
          lineHeight: 1.6,
        }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentQuestion.hint}</ReactMarkdown>
        </div>
      )}

      {/* Study deck panel — Practice mode only */}
      {isPractice && showGuide && currentQuestion.guide && (
        <div style={{
          marginTop: '12px',
          padding: '14px 16px',
          background: isDark ? '#0b1d24' : '#ecfeff',
          borderRadius: '6px',
          borderLeft: '3px solid #06b6d4',
          fontSize: '13px',
          color: c.questionText,
          lineHeight: 1.7,
        }}>
          <div style={{
            fontWeight: 600,
            marginBottom: '8px',
            fontSize: '12px',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            color: isDark ? '#67e8f9' : '#0e7490',
          }}>
            Scenario Deck
          </div>
          <div className="question-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code: ({ children, className }) => {
                  if (!className) {
                    return (
                      <code style={{
                        background: c.codeBg,
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '13px',
                        color: c.codeText,
                        border: `1px solid ${c.codeBorder}`,
                        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                      }}>
                        {children}
                      </code>
                    );
                  }
                  return <code className={className}>{children}</code>;
                },
                pre: ({ children }) => (
                  <pre style={{
                    background: '#1c1c21',
                    padding: '14px 16px',
                    borderRadius: '6px',
                    overflow: 'auto',
                    fontSize: '13px',
                    color: '#fafafa',
                    margin: '10px 0',
                    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                  }}>
                    {children}
                  </pre>
                ),
              }}
            >
              {currentQuestion.guide}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* Solution panel — Practice mode only, after validation */}
      {isPractice && showSolution && currentQuestion.solution && (
        <div style={{
          marginTop: '12px',
          padding: '14px 16px',
          background: isDark ? '#0c2d1b' : '#f0fdf4',
          borderRadius: '6px',
          borderLeft: '3px solid #16a34a',
          fontSize: '13px',
          color: isDark ? '#86efac' : '#166534',
          lineHeight: 1.6,
        }}>
          <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Solution
          </div>
          <div className="question-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code: ({ children, className }) => {
                  if (!className) {
                    return (
                      <code style={{
                        background: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.06)',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '13px',
                        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                      }}>
                        {children}
                      </code>
                    );
                  }
                  return <code className={className}>{children}</code>;
                },
                pre: ({ children }) => (
                  <pre style={{
                    background: '#1c1c21',
                    padding: '14px 16px',
                    borderRadius: '6px',
                    overflow: 'auto',
                    fontSize: '13px',
                    color: '#fafafa',
                    margin: '10px 0',
                    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                  }}>
                    {children}
                  </pre>
                ),
              }}
            >
              {currentQuestion.solution}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* Validation results — only in Practice mode */}
      {isPractice && validationResult && (
        <div style={{ marginTop: '16px' }}>
          <div style={{
            fontSize: '14px',
            fontWeight: 600,
            marginBottom: '8px',
            color: validationResult.passed ? '#16a34a' : '#dc2626',
          }}>
            {validationResult.passed ? 'All checks passed!' : 'Some checks failed'}
          </div>
          {validationResult.results.map((r, i) => (
            <div key={i} style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'flex-start',
              padding: '8px 0',
              fontSize: '13px',
              borderBottom: `1px solid ${c.validationBorder}`,
            }}>
              <span style={{ color: r.passed ? '#16a34a' : '#dc2626', flexShrink: 0, fontWeight: 600 }}>
                {r.passed ? '\u2713' : '\u2717'}
              </span>
              <span style={{ color: c.questionText }}>{r.description}</span>
              {!r.passed && (
                <span style={{ color: c.questionMuted, fontSize: '12px', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  got: {r.actual || '(empty)'}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function difficultyColor(d: string): string {
  switch (d) {
    case 'easy': return '#16a34a';
    case 'medium': return '#ea580c';
    case 'hard': return '#dc2626';
    default: return '#64748b';
  }
}
