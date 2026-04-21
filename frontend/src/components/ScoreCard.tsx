import { useState } from 'react';
import { useExam } from '../hooks/useExam';
import { useTheme, colors } from '../hooks/useTheme';
import type { QuestionResultDetail, CategoryScore } from '../types';

export function ScoreCard() {
  const { examResult, reset } = useExam();
  const { isDark } = useTheme();
  const c = colors(isDark);

  if (!examResult) return null;

  const passScore = examResult.passScore || 66;
  const passing = examResult.score >= passScore;

  return (
    <div style={{
      minHeight: '100vh',
      background: c.pageBg,
      overflowY: 'auto',
    }}>
      {/* Top bar */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: isDark ? '#1a1a2e' : '#1e3a5f',
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}>
        <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>
          Exam Review
        </span>
        <button
          onClick={reset}
          style={{
            padding: '8px 20px',
            background: '#326ce5',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 600,
          }}
        >
          Start New Exam
        </button>
      </div>

      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px' }}>
        {/* Score summary card */}
        <ScoreSummary
          score={examResult.score}
          earned={examResult.earned}
          total={examResult.total}
          passScore={passScore}
          passing={passing}
          isDark={isDark}
          c={c}
          questions={examResult.questions}
        />

        {/* Category breakdown */}
        {examResult.categories && examResult.categories.length > 0 && (
          <CategoryBreakdown
            categories={examResult.categories}
            isDark={isDark}
            c={c}
          />
        )}

        {/* Per-question review */}
        <QuestionReview
          questions={examResult.questions}
          isDark={isDark}
          c={c}
        />
      </div>
    </div>
  );
}

/* ─── Score Summary ─── */
function ScoreSummary({ score, earned, total, passScore, passing, isDark, c, questions }: {
  score: number; earned: number; total: number; passScore: number; passing: boolean;
  isDark: boolean; c: ReturnType<typeof colors>; questions: QuestionResultDetail[];
}) {
  const green = '#16a34a';
  const red = '#dc2626';
  const grey = '#9ca3af';
  const color = passing ? green : red;
  const bgTint = passing
    ? (isDark ? 'rgba(22,163,106,0.08)' : '#f0fdf4')
    : (isDark ? 'rgba(220,38,38,0.08)' : '#fef2f2');

  const passedCount = questions.filter(q => q.passed).length;
  const failedCount = questions.filter(q => q.attempted && !q.passed).length;
  const skippedCount = questions.filter(q => !q.attempted).length;

  const stats = [
    { label: 'Passed', value: passedCount, color: green },
    { label: 'Failed', value: failedCount, color: red },
    { label: 'Skipped', value: skippedCount, color: grey },
  ];

  return (
    <div style={{
      background: c.cardBg,
      borderRadius: '12px',
      padding: '32px',
      marginBottom: '20px',
      border: `2px solid ${color}20`,
      boxShadow: isDark ? 'none' : '0 2px 12px rgba(0,0,0,0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '32px', flexWrap: 'wrap' }}>
        {/* Score circle */}
        <div style={{
          width: '120px', height: '120px', borderRadius: '50%',
          border: `5px solid ${color}`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: bgTint, flexShrink: 0,
        }}>
          <span style={{ fontSize: '36px', fontWeight: 700, color }}>{score}%</span>
        </div>

        {/* Details */}
        <div style={{ flex: 1, minWidth: '200px' }}>
          <div style={{
            fontSize: '28px', fontWeight: 700, color,
            marginBottom: '8px',
          }}>
            {passing ? 'PASS' : 'FAIL'}
          </div>
          <div style={{ color: c.questionMuted, fontSize: '14px', lineHeight: '1.8' }}>
            <div>Score: <strong style={{ color: c.questionText }}>{earned}</strong> / {total} weight ({score}%)</div>
            <div>Pass threshold: <strong style={{ color: c.questionText }}>{passScore}%</strong></div>
          </div>
        </div>

        {/* Stats grid */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px',
          textAlign: 'center', flexShrink: 0,
        }}>
          {stats.map(s => (
            <div key={s.label}>
              <div style={{ fontSize: '28px', fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: '12px', color: c.questionMuted, fontWeight: 500 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Category Breakdown ─── */
function CategoryBreakdown({ categories, isDark, c }: {
  categories: CategoryScore[]; isDark: boolean; c: ReturnType<typeof colors>;
}) {
  return (
    <div style={{
      background: c.cardBg,
      borderRadius: '12px',
      padding: '24px',
      marginBottom: '20px',
      boxShadow: isDark ? 'none' : '0 2px 12px rgba(0,0,0,0.06)',
      border: isDark ? `1px solid ${c.cardBorder}` : 'none',
    }}>
      <h3 style={{
        fontSize: '14px', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.5px', color: c.questionMuted, marginBottom: '16px',
        margin: '0 0 16px 0',
      }}>
        Score by Category
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {categories.map((cat) => (
          <div key={cat.category}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: '6px',
            }}>
              <span style={{ fontSize: '14px', color: c.questionText, fontWeight: 500 }}>
                {cat.category}
              </span>
              <span style={{
                fontSize: '13px', fontWeight: 600,
                color: cat.score >= 66 ? '#16a34a' : (cat.score >= 40 ? '#d97706' : '#dc2626'),
              }}>
                {cat.earned}/{cat.total} ({cat.score}%)
              </span>
            </div>
            {/* Progress bar */}
            <div style={{
              height: '8px', borderRadius: '4px',
              background: isDark ? '#2a2a3e' : '#e5e7eb',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', borderRadius: '4px',
                width: `${cat.score}%`,
                background: cat.score >= 66 ? '#16a34a' : (cat.score >= 40 ? '#d97706' : '#dc2626'),
                transition: 'width 0.5s ease',
              }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Per-Question Review ─── */
function QuestionReview({ questions, isDark, c }: {
  questions: QuestionResultDetail[]; isDark: boolean; c: ReturnType<typeof colors>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div style={{
      background: c.cardBg,
      borderRadius: '12px',
      padding: '24px',
      boxShadow: isDark ? 'none' : '0 2px 12px rgba(0,0,0,0.06)',
      border: isDark ? `1px solid ${c.cardBorder}` : 'none',
    }}>
      <h3 style={{
        fontSize: '14px', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.5px', color: c.questionMuted,
        margin: '0 0 16px 0',
      }}>
        Question Review ({questions.filter(q => q.passed).length}/{questions.length} passed)
      </h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {questions.map((q, i) => {
          const isExpanded = expandedId === q.id;
          return (
            <QuestionRow
              key={q.id}
              question={q}
              index={i + 1}
              isExpanded={isExpanded}
              onToggle={() => setExpandedId(isExpanded ? null : q.id)}
              isDark={isDark}
              c={c}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ─── Single Question Row ─── */
function QuestionRow({ question: q, index, isExpanded, onToggle, isDark, c }: {
  question: QuestionResultDetail; index: number; isExpanded: boolean;
  onToggle: () => void; isDark: boolean; c: ReturnType<typeof colors>;
}) {
  const statusColor = q.passed ? '#16a34a' : (q.attempted ? '#dc2626' : '#9ca3af');
  const statusIcon = q.passed ? '✓' : (q.attempted ? '✗' : '–');
  const statusLabel = q.passed ? 'Passed' : (q.attempted ? 'Failed' : 'Skipped');

  const difficultyColor = q.difficulty === 'hard' ? '#dc2626'
    : q.difficulty === 'medium' ? '#d97706' : '#16a34a';

  return (
    <div style={{
      borderRadius: '8px',
      border: `1px solid ${isExpanded ? '#326ce5' : (isDark ? '#2a2a3e' : '#e5e7eb')}`,
      overflow: 'hidden',
      marginBottom: '4px',
      transition: 'border-color 0.2s',
    }}>
      {/* Header row — clickable */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '12px 16px',
          cursor: 'pointer',
          background: isExpanded
            ? (isDark ? 'rgba(50,108,229,0.08)' : 'rgba(50,108,229,0.04)')
            : 'transparent',
        }}
      >
        {/* Status icon */}
        <span style={{
          width: '28px', height: '28px', borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '14px', fontWeight: 700, color: '#fff', flexShrink: 0,
          background: statusColor,
        }}>
          {statusIcon}
        </span>

        {/* Question number + title */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: '14px', fontWeight: 600, color: c.questionText,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            Q{index}. {q.title}
          </div>
          <div style={{ fontSize: '12px', color: c.questionMuted, marginTop: '2px' }}>
            {q.category}
          </div>
        </div>

        {/* Badges */}
        <span style={{
          fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
          fontWeight: 600, color: difficultyColor, flexShrink: 0,
          background: isDark ? `${difficultyColor}15` : `${difficultyColor}10`,
          border: `1px solid ${difficultyColor}30`,
        }}>
          {q.difficulty}
        </span>

        <span style={{
          fontSize: '12px', color: c.questionMuted, fontWeight: 600,
          minWidth: '50px', textAlign: 'right', flexShrink: 0,
        }}>
          {q.passed ? q.weight : 0}/{q.weight}
        </span>

        {/* Expand arrow */}
        <span style={{
          fontSize: '12px', color: c.questionMuted, flexShrink: 0,
          transform: isExpanded ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.2s',
        }}>
          ▼
        </span>
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div style={{
          padding: '0 16px 16px',
          borderTop: `1px solid ${isDark ? '#2a2a3e' : '#e5e7eb'}`,
        }}>
          {/* Status banner */}
          <div style={{
            margin: '12px 0',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: 600,
            color: statusColor,
            background: isDark ? `${statusColor}15` : `${statusColor}08`,
            border: `1px solid ${statusColor}30`,
          }}>
            {statusLabel} — {q.passed ? `+${q.weight}` : '0'}/{q.weight} weight
          </div>

          {/* Task */}
          <DetailSection title="Task" isDark={isDark} c={c}>
            <pre style={{
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              fontSize: '13px', lineHeight: '1.6',
              color: c.questionText, margin: 0,
              fontFamily: 'inherit',
            }}>
              {q.task}
            </pre>
          </DetailSection>

          {/* Solution */}
          {q.solution && (
            <CollapsibleSection title="Solution" isDark={isDark} c={c}>
              <pre style={{
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontSize: '13px', lineHeight: '1.6',
                color: isDark ? '#a5d6ff' : '#1e40af',
                background: isDark ? '#0d1117' : '#f0f4ff',
                padding: '12px', borderRadius: '6px', margin: 0,
                fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
                border: `1px solid ${isDark ? '#21262d' : '#dbeafe'}`,
              }}>
                {q.solution}
              </pre>
            </CollapsibleSection>
          )}

          {/* Hint */}
          {q.hint && (
            <CollapsibleSection title="Hint" isDark={isDark} c={c} defaultOpen={false}>
              <pre style={{
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                fontSize: '13px', lineHeight: '1.6',
                color: c.questionText, margin: 0,
                fontFamily: 'inherit',
              }}>
                {q.hint}
              </pre>
            </CollapsibleSection>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Helpers ─── */
function DetailSection({ title, children, isDark, c }: {
  title: string; children: React.ReactNode; isDark: boolean; c: ReturnType<typeof colors>;
}) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{
        fontSize: '12px', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.5px', color: c.questionMuted, marginBottom: '8px',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function CollapsibleSection({ title, children, isDark, c, defaultOpen = true }: {
  title: string; children: React.ReactNode; isDark: boolean;
  c: ReturnType<typeof colors>; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ marginBottom: '12px' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          fontSize: '12px', fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.5px', color: '#326ce5', marginBottom: open ? '8px' : 0,
          cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
          userSelect: 'none',
        }}
      >
        <span style={{
          fontSize: '10px',
          transform: open ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
        }}>
          ▶
        </span>
        {title}
      </div>
      {open && children}
    </div>
  );
}
