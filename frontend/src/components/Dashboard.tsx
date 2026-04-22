import { useState, useEffect } from 'react';
import { useTheme, colors } from '../hooks/useTheme';
import { api } from '../api/client';
import type { AttemptSummary, AttemptRecord } from '../types';

interface DashboardProps {
  onBack: () => void;
}

export function Dashboard({ onBack }: DashboardProps) {
  const { isDark } = useTheme();
  const c = colors(isDark);
  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const [selectedAttempt, setSelectedAttempt] = useState<AttemptRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAttempts();
  }, []);

  const loadAttempts = async () => {
    setLoading(true);
    try {
      const data = await api.listAttempts();
      setAttempts(data);
    } catch {
      // ignore
    }
    setLoading(false);
  };

  const viewAttempt = async (id: string) => {
    try {
      const detail = await api.getAttempt(id);
      setSelectedAttempt(detail);
    } catch {
      // ignore
    }
  };

  const deleteAttempt = async (id: string) => {
    try {
      await api.deleteAttempt(id);
      setAttempts(prev => prev.filter(a => a.id !== id));
      if (selectedAttempt?.id === id) {
        setSelectedAttempt(null);
      }
    } catch {
      // ignore
    }
  };

  // If viewing a specific attempt, show the full review
  if (selectedAttempt) {
    return (
      <AttemptReview
        attempt={selectedAttempt}
        onBack={() => setSelectedAttempt(null)}
        isDark={isDark}
        c={c}
      />
    );
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: c.pageBg,
      overflowY: 'auto',
    }}>
      {/* Top bar */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: isDark ? '#1c1c21' : '#0891b2',
        padding: '12px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            onClick={onBack}
            style={{
              padding: '6px 14px', background: 'rgba(255,255,255,0.1)',
              color: '#fff', border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
            }}
          >
            Back
          </button>
          <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>
            Past Attempts
          </span>
        </div>
        <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '13px' }}>
          {attempts.length} attempt{attempts.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: c.questionMuted, padding: '48px' }}>
            Loading...
          </div>
        ) : attempts.length === 0 ? (
          <EmptyState isDark={isDark} c={c} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {attempts.map(a => (
              <AttemptRow
                key={a.id}
                attempt={a}
                onView={() => viewAttempt(a.id)}
                onDelete={() => deleteAttempt(a.id)}
                isDark={isDark}
                c={c}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Empty State ─── */
function EmptyState({ isDark, c }: { isDark: boolean; c: ReturnType<typeof colors> }) {
  return (
    <div style={{
      textAlign: 'center', padding: '64px 24px',
      background: c.cardBg, borderRadius: '12px',
      border: isDark ? `1px solid ${c.cardBorder}` : 'none',
    }}>
      <div style={{ fontSize: '48px', marginBottom: '16px' }}>📋</div>
      <div style={{ fontSize: '18px', fontWeight: 600, color: c.questionText, marginBottom: '8px' }}>
        No attempts yet
      </div>
      <div style={{ fontSize: '14px', color: c.questionMuted }}>
        Complete an exam to see your results here.
      </div>
    </div>
  );
}

/* ─── Single Attempt Row ─── */
function AttemptRow({ attempt: a, onView, onDelete, isDark, c }: {
  attempt: AttemptSummary; onView: () => void; onDelete: () => void;
  isDark: boolean; c: ReturnType<typeof colors>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const passColor = a.passed ? '#16a34a' : '#dc2626';

  const dateStr = formatDate(a.date);

  return (
    <div
      onClick={onView}
      style={{
        display: 'flex', alignItems: 'center', gap: '16px',
        padding: '16px 20px',
        background: c.cardBg, borderRadius: '10px', cursor: 'pointer',
        border: isDark ? `1px solid ${c.cardBorder}` : '1px solid #e4e4e7',
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#06b6d4';
        e.currentTarget.style.boxShadow = '0 2px 8px rgba(50,108,229,0.1)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = isDark ? c.cardBorder : '#e4e4e7';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {/* Score badge */}
      <div style={{
        width: '52px', height: '52px', borderRadius: '50%',
        border: `3px solid ${passColor}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
        background: isDark ? `${passColor}15` : `${passColor}08`,
      }}>
        <span style={{ fontSize: '16px', fontWeight: 700, color: passColor }}>
          {a.score}%
        </span>
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '15px', fontWeight: 600, color: c.questionText,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {a.examName}
        </div>
        <div style={{ fontSize: '13px', color: c.questionMuted, marginTop: '3px' }}>
          {dateStr} · {a.earned}/{a.total} weight
        </div>
      </div>

      {/* Pass/Fail tag */}
      <span style={{
        padding: '4px 12px', borderRadius: '4px',
        fontSize: '12px', fontWeight: 700,
        color: passColor,
        background: isDark ? `${passColor}15` : `${passColor}08`,
        border: `1px solid ${passColor}30`,
        flexShrink: 0,
      }}>
        {a.passed ? 'PASS' : 'FAIL'}
      </span>

      {/* Delete button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (confirmDelete) {
            onDelete();
            setConfirmDelete(false);
          } else {
            setConfirmDelete(true);
            setTimeout(() => setConfirmDelete(false), 3000);
          }
        }}
        style={{
          padding: '6px 10px', border: 'none', borderRadius: '4px',
          cursor: 'pointer', fontSize: '12px', flexShrink: 0,
          background: confirmDelete ? '#dc2626' : 'transparent',
          color: confirmDelete ? '#fff' : c.questionMuted,
        }}
        title="Delete attempt"
      >
        {confirmDelete ? 'Confirm?' : '✕'}
      </button>
    </div>
  );
}

/* ─── Attempt Review (reuses ScoreCard-style layout) ─── */
function AttemptReview({ attempt, onBack, isDark, c }: {
  attempt: AttemptRecord; onBack: () => void;
  isDark: boolean; c: ReturnType<typeof colors>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const passColor = attempt.passed ? '#16a34a' : '#dc2626';
  const bgTint = attempt.passed
    ? (isDark ? 'rgba(22,163,106,0.08)' : '#f0fdf4')
    : (isDark ? 'rgba(220,38,38,0.08)' : '#fef2f2');

  const passedCount = attempt.questions.filter(q => q.passed).length;
  const failedCount = attempt.questions.filter(q => q.attempted && !q.passed).length;
  const skippedCount = attempt.questions.filter(q => !q.attempted).length;

  return (
    <div style={{ minHeight: '100vh', background: c.pageBg, overflowY: 'auto' }}>
      {/* Top bar */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: isDark ? '#1c1c21' : '#0891b2',
        padding: '12px 24px',
        display: 'flex', alignItems: 'center', gap: '16px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}>
        <button
          onClick={onBack}
          style={{
            padding: '6px 14px', background: 'rgba(255,255,255,0.1)',
            color: '#fff', border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
          }}
        >
          Back
        </button>
        <span style={{ color: '#fff', fontSize: '16px', fontWeight: 700 }}>
          {attempt.examName}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '13px' }}>
          {formatDate(attempt.date)}
        </span>
      </div>

      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px' }}>
        {/* Score summary */}
        <div style={{
          background: c.cardBg, borderRadius: '12px', padding: '32px',
          marginBottom: '20px', border: `2px solid ${passColor}20`,
          boxShadow: isDark ? 'none' : '0 2px 12px rgba(0,0,0,0.06)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '32px', flexWrap: 'wrap' }}>
            <div style={{
              width: '120px', height: '120px', borderRadius: '50%',
              border: `5px solid ${passColor}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: bgTint, flexShrink: 0,
            }}>
              <span style={{ fontSize: '36px', fontWeight: 700, color: passColor }}>{attempt.score}%</span>
            </div>
            <div style={{ flex: 1, minWidth: '200px' }}>
              <div style={{ fontSize: '28px', fontWeight: 700, color: passColor, marginBottom: '8px' }}>
                {attempt.passed ? 'PASS' : 'FAIL'}
              </div>
              <div style={{ color: c.questionMuted, fontSize: '14px', lineHeight: '1.8' }}>
                <div>Score: <strong style={{ color: c.questionText }}>{attempt.earned}</strong> / {attempt.total} weight ({attempt.score}%)</div>
                <div>Pass threshold: <strong style={{ color: c.questionText }}>{attempt.passScore}%</strong></div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', textAlign: 'center', flexShrink: 0 }}>
              {[
                { label: 'Passed', value: passedCount, color: '#16a34a' },
                { label: 'Failed', value: failedCount, color: '#dc2626' },
                { label: 'Skipped', value: skippedCount, color: '#9ca3af' },
              ].map(s => (
                <div key={s.label}>
                  <div style={{ fontSize: '28px', fontWeight: 700, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: '12px', color: c.questionMuted, fontWeight: 500 }}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Category breakdown */}
        {attempt.categories && attempt.categories.length > 0 && (
          <div style={{
            background: c.cardBg, borderRadius: '12px', padding: '24px',
            marginBottom: '20px',
            boxShadow: isDark ? 'none' : '0 2px 12px rgba(0,0,0,0.06)',
            border: isDark ? `1px solid ${c.cardBorder}` : 'none',
          }}>
            <h3 style={{
              fontSize: '14px', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.5px', color: c.questionMuted, margin: '0 0 16px 0',
            }}>
              Score by Category
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {attempt.categories.map(cat => (
                <div key={cat.category}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '14px', color: c.questionText, fontWeight: 500 }}>{cat.category}</span>
                    <span style={{
                      fontSize: '13px', fontWeight: 600,
                      color: cat.score >= 66 ? '#16a34a' : (cat.score >= 40 ? '#d97706' : '#dc2626'),
                    }}>
                      {cat.earned}/{cat.total} ({cat.score}%)
                    </span>
                  </div>
                  <div style={{ height: '8px', borderRadius: '4px', background: isDark ? '#2e2e35' : '#e4e4e7', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: '4px', width: `${cat.score}%`,
                      background: cat.score >= 66 ? '#16a34a' : (cat.score >= 40 ? '#d97706' : '#dc2626'),
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Per-question review */}
        <div style={{
          background: c.cardBg, borderRadius: '12px', padding: '24px',
          boxShadow: isDark ? 'none' : '0 2px 12px rgba(0,0,0,0.06)',
          border: isDark ? `1px solid ${c.cardBorder}` : 'none',
        }}>
          <h3 style={{
            fontSize: '14px', fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.5px', color: c.questionMuted, margin: '0 0 16px 0',
          }}>
            Question Review ({passedCount}/{attempt.questions.length} passed)
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {attempt.questions.map((q, i) => {
              const isExpanded = expandedId === q.id;
              const statusColor = q.passed ? '#16a34a' : (q.attempted ? '#dc2626' : '#9ca3af');
              const statusIcon = q.passed ? '✓' : (q.attempted ? '✗' : '–');
              const statusLabel = q.passed ? 'Passed' : (q.attempted ? 'Failed' : 'Skipped');
              const difficultyColor = q.difficulty === 'hard' ? '#dc2626'
                : q.difficulty === 'medium' ? '#d97706' : '#16a34a';

              return (
                <div key={q.id} style={{
                  borderRadius: '8px',
                  border: `1px solid ${isExpanded ? '#06b6d4' : (isDark ? '#2e2e35' : '#e4e4e7')}`,
                  overflow: 'hidden', marginBottom: '4px',
                }}>
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : q.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '12px',
                      padding: '12px 16px', cursor: 'pointer',
                      background: isExpanded ? (isDark ? 'rgba(50,108,229,0.08)' : 'rgba(50,108,229,0.04)') : 'transparent',
                    }}
                  >
                    <span style={{
                      width: '28px', height: '28px', borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '14px', fontWeight: 700, color: '#fff', flexShrink: 0,
                      background: statusColor,
                    }}>
                      {statusIcon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: '14px', fontWeight: 600, color: c.questionText,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        Q{i + 1}. {q.title}
                      </div>
                      <div style={{ fontSize: '12px', color: c.questionMuted, marginTop: '2px' }}>{q.category}</div>
                    </div>
                    <span style={{
                      fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
                      fontWeight: 600, color: difficultyColor, flexShrink: 0,
                      background: isDark ? `${difficultyColor}15` : `${difficultyColor}10`,
                      border: `1px solid ${difficultyColor}30`,
                    }}>
                      {q.difficulty}
                    </span>
                    <span style={{ fontSize: '12px', color: c.questionMuted, fontWeight: 600, minWidth: '50px', textAlign: 'right', flexShrink: 0 }}>
                      {q.passed ? q.weight : 0}/{q.weight}
                    </span>
                    <span style={{
                      fontSize: '12px', color: c.questionMuted, flexShrink: 0,
                      transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s',
                    }}>▼</span>
                  </div>

                  {isExpanded && (
                    <div style={{ padding: '0 16px 16px', borderTop: `1px solid ${isDark ? '#2e2e35' : '#e4e4e7'}` }}>
                      <div style={{
                        margin: '12px 0', padding: '8px 12px', borderRadius: '6px',
                        fontSize: '13px', fontWeight: 600, color: statusColor,
                        background: isDark ? `${statusColor}15` : `${statusColor}08`,
                        border: `1px solid ${statusColor}30`,
                      }}>
                        {statusLabel} — {q.passed ? `+${q.weight}` : '0'}/{q.weight} weight
                      </div>
                      <div style={{ marginBottom: '12px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: c.questionMuted, marginBottom: '8px' }}>Task</div>
                        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px', lineHeight: '1.6', color: c.questionText, margin: 0, fontFamily: 'inherit' }}>
                          {q.task}
                        </pre>
                      </div>
                      {q.solution && (
                        <div style={{ marginBottom: '12px' }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#06b6d4', marginBottom: '8px' }}>Solution</div>
                          <pre style={{
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            fontSize: '13px', lineHeight: '1.6',
                            color: isDark ? '#a5d6ff' : '#0e7490',
                            background: isDark ? '#0d1117' : '#ecfeff',
                            padding: '12px', borderRadius: '6px', margin: 0,
                            fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
                            border: `1px solid ${isDark ? '#21262d' : '#a5f3fc'}`,
                          }}>
                            {q.solution}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Helpers ─── */
function formatDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return isoDate;
  }
}
