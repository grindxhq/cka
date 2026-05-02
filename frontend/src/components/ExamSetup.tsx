import { useEffect, useState, useRef } from 'react';
import { useExam, type SetupProgress, type ClusterState } from '../hooks/useExam';
import { useTheme, colors } from '../hooks/useTheme';
import { api } from '../api/client';
import { Dashboard } from './Dashboard';
import { RevisionDeck } from './RevisionDeck';
import type { Prerequisites } from '../types';

const difficultyColors: Record<string, string> = {
  beginner: '#10b981',
  intermediate: '#f97316',
  advanced: '#ef4444',
  expert: '#a855f7',
};

const ACCENT = '#06b6d4';
const ACCENT_HOVER = '#22d3ee';

export function ExamSetup() {
  const {
    exams, selectedExamId, questions,
    startExam, selectExam, loadExams,
    loading, error, progressMessage, mode, setMode,
    setupProgress,
  } = useExam();
  const { isDark, toggle } = useTheme();
  const c = colors(isDark);
  const [duration, setDuration] = useState(7200);
  const [prereqs, setPrereqs] = useState<Prerequisites | null>(null);
  const [checking, setChecking] = useState(true);
  const [showDashboard, setShowDashboard] = useState(false);
  const [activePane, setActivePane] = useState<'exam' | 'deck'>('exam');
  const [deckMounted, setDeckMounted] = useState(false);

  useEffect(() => {
    loadExams();
    checkStatus();
  }, []);

  useEffect(() => {
    if (activePane === 'deck') setDeckMounted(true);
  }, [activePane]);

  const selectedExam = exams.find(e => e.id === selectedExamId);

  // Sync duration with selected exam's default
  useEffect(() => {
    if (selectedExam) {
      setDuration(selectedExam.duration || 7200);
    }
  }, [selectedExamId]);

  const checkStatus = async () => {
    setChecking(true);
    try {
      const p = await api.getPrerequisites();
      setPrereqs(p);
    } catch {
      // ignore
    }
    setChecking(false);
  };

  const allReady = prereqs?.docker && prereqs?.kind && prereqs?.kubectl;

  if (showDashboard) {
    return <Dashboard onBack={() => setShowDashboard(false)} />;
  }

  // Compute category weights from questions for coverage bars
  const categoryWeights: Record<string, number> = {};
  let totalWeight = 0;
  for (const q of questions) {
    categoryWeights[q.category] = (categoryWeights[q.category] || 0) + q.weight;
    totalWeight += q.weight;
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: isDark ? '#111114' : '#f4f4f5',
    }}>
      {/* ── Top bar ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 24px',
        borderBottom: `1px solid ${c.cardBorder}`,
        background: isDark ? '#111114' : '#ffffff',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            fontSize: '24px',
            fontWeight: 800,
            letterSpacing: '-0.9px',
            color: c.questionHeading,
            lineHeight: 1,
          }}>
            grind<span style={{ color: ACCENT_HOVER }}>x</span>
          </div>
          <span style={{ fontSize: '17px', fontWeight: 700, color: c.questionHeading }}>
            CKA Mock Exam
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={() => setShowDashboard(true)}
            style={{
              padding: '6px 14px', background: 'transparent',
              color: c.questionMuted, border: `1px solid ${c.cardBorder}`,
              borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = ACCENT; e.currentTarget.style.borderColor = ACCENT; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = c.questionMuted; e.currentTarget.style.borderColor = c.cardBorder; }}
          >
            Past Attempts
          </button>
          <button
            onClick={toggle}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{
              padding: '6px 10px', background: 'transparent',
              color: c.questionMuted, border: `1px solid ${c.cardBorder}`,
              borderRadius: '6px', cursor: 'pointer', fontSize: '14px', lineHeight: 1,
            }}
          >
            {isDark ? '\u2600' : '\u263E'}
          </button>
        </div>
      </div>

      {/* ── Main layout ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '300px 1fr',
        flex: 1,
        overflow: 'hidden',
      }}>
        {/* ── Left sidebar: exam list ── */}
        <div style={{
          borderRight: `1px solid ${c.cardBorder}`,
          overflowY: 'auto',
          background: isDark ? '#111114' : '#ffffff',
          padding: '16px 0',
        }}>
          <div style={{
            padding: '0 16px 12px',
            fontSize: '11px', fontWeight: 600, textTransform: 'uppercase',
            letterSpacing: '0.5px', color: isDark ? '#71717a' : '#94a3b8',
          }}>
            Select Exam
          </div>
          {exams.map((exam) => {
            const isSelected = exam.id === selectedExamId;
            const diffColor = difficultyColors[exam.difficulty] || '#71717a';
            return (
              <div
                key={exam.id}
                onClick={() => {
                  setActivePane('exam');
                  selectExam(exam.id);
                }}
                style={{
                  padding: '14px 16px',
                  cursor: 'pointer',
                  borderLeft: `3px solid ${isSelected ? ACCENT : 'transparent'}`,
                  background: isSelected ? (isDark ? '#1c1c21' : '#fafafa') : 'transparent',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = isDark ? '#1c1c2140' : '#fafafa'; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: c.questionHeading }}>
                    {exam.name}
                  </span>
                  <span style={{
                    fontSize: '9px', padding: '1px 6px', borderRadius: '3px',
                    background: diffColor, color: 'white',
                    fontWeight: 700, textTransform: 'uppercase',
                  }}>
                    {exam.difficulty}
                  </span>
                </div>
                <div style={{
                  fontSize: '11px', color: isDark ? '#52525b' : '#a1a1aa',
                  marginTop: '4px',
                }}>
                  {exam.questionCount} tasks &middot; {Math.round(exam.duration / 60)} min &middot; {exam.clusters.length} cluster{exam.clusters.length > 1 ? 's' : ''}
                </div>
              </div>
            );
          })}

          <div style={{
            margin: '14px 16px 10px',
            borderTop: `1px solid ${c.cardBorder}`,
          }} />

          <button
            onClick={() => setActivePane('deck')}
            style={{
              width: 'calc(100% - 32px)',
              margin: '0 16px',
              padding: '14px 16px',
              borderRadius: '8px',
              border: `1px solid ${c.cardBorder}`,
              background: 'transparent',
              color: c.questionText,
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = ACCENT;
              e.currentTarget.style.background = isDark ? '#0b1d24' : '#ecfeff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = c.cardBorder;
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>
              Revision Deck
              <span style={{ marginLeft: '6px', fontSize: '11px', color: ACCENT_HOVER }}>→</span>
            </div>
            <div style={{ fontSize: '11px', color: c.questionMuted }}>
              Component guides, pitfalls, and trace paths without starting Docker
            </div>
          </button>
        </div>

        {/* ── Right: selected exam details ── */}
        <div style={{
          overflowY: 'auto',
          padding: '24px 32px',
          background: isDark ? '#0a0a0c' : '#f4f4f5',
        }}>
          {(
            <>
          {/* Stats banner */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '14px',
            marginBottom: '24px',
          }}>
            <StatCard label="Questions" c={c} isDark={isDark}>
              <span style={{ fontSize: '26px', fontWeight: 700, color: c.questionHeading, fontFamily: "'SF Mono', Menlo, monospace" }}>
                {selectedExam?.questionCount ?? 0}
              </span>
              <span style={{ fontSize: '11px', color: isDark ? '#52525b' : '#94a3b8', marginTop: '2px' }}>
                {selectedExam?.totalWeight ?? 0} total points
              </span>
            </StatCard>
            <StatCard label="Duration" c={c} isDark={isDark}>
              <span style={{ fontSize: '26px', fontWeight: 700, color: c.questionHeading, fontFamily: "'SF Mono', Menlo, monospace" }}>
                {Math.round(duration / 60)}
                <span style={{ fontSize: '14px', color: isDark ? '#71717a' : '#94a3b8' }}>min</span>
              </span>
              <span style={{ fontSize: '11px', color: isDark ? '#52525b' : '#94a3b8', marginTop: '2px' }}>
                Pass score: {selectedExam?.passScore ?? 66}%
              </span>
            </StatCard>
            <StatCard label="Difficulty" c={c} isDark={isDark}>
              <span style={{
                fontSize: '16px', fontWeight: 700, marginTop: '4px',
                color: difficultyColors[selectedExam?.difficulty ?? ''] || c.questionMuted,
                textTransform: 'capitalize',
              }}>
                {selectedExam?.difficulty ?? '—'}
              </span>
              <span style={{ fontSize: '11px', color: isDark ? '#52525b' : '#94a3b8', marginTop: '2px' }}>
                {selectedExam?.clusters.length ?? 0} cluster{(selectedExam?.clusters.length ?? 0) > 1 ? 's' : ''}
              </span>
            </StatCard>
            <StatCard label="Prerequisites" c={c} isDark={isDark}>
              {checking ? (
                <span style={{ fontSize: '12px', color: c.questionMuted }}>Checking...</span>
              ) : prereqs ? (
                <>
                  <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
                    <PrereqDot ok={prereqs.docker} label="Docker" />
                    <PrereqDot ok={prereqs.kind} label="Kind" />
                    <PrereqDot ok={prereqs.kubectl} label="kubectl" />
                  </div>
                  <div style={{ fontSize: '11px', marginTop: '4px' }}>
                    {allReady
                      ? <span style={{ color: '#34d399' }}>All ready</span>
                      : <span style={{ color: '#f87171' }}>Missing dependencies</span>
                    }
                  </div>
                </>
              ) : (
                <span style={{ fontSize: '11px', color: '#f87171' }}>Check failed</span>
              )}
              <button onClick={checkStatus} style={{
                position: 'absolute', top: '8px', right: '8px',
                padding: '2px 8px', background: 'transparent',
                color: isDark ? '#52525b' : '#94a3b8',
                border: `1px solid ${c.cardBorder}`,
                borderRadius: '3px', cursor: 'pointer', fontSize: '10px',
              }}>
                Refresh
              </button>
            </StatCard>
          </div>

          {/* Clusters + Domain Coverage */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '14px',
            marginBottom: '20px',
          }}>
            {/* Clusters */}
            <Panel title="Clusters" c={c} isDark={isDark}>
              {selectedExam && selectedExam.clusters.length > 0 ? (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {selectedExam.clusters.map((cl) => (
                    <div key={cl.name} style={{
                      padding: '10px 14px',
                      background: isDark ? '#111114' : '#fafafa',
                      borderRadius: '8px',
                      border: `1px solid ${c.cardBorder}`,
                      flex: 1, minWidth: '140px',
                    }}>
                      <div style={{
                        fontWeight: 600, fontFamily: "'SF Mono', Menlo, monospace",
                        color: ACCENT_HOVER, fontSize: '13px',
                      }}>
                        {cl.name}
                      </div>
                      <div style={{ color: isDark ? '#71717a' : '#94a3b8', fontSize: '11px', marginTop: '3px' }}>
                        {cl.controlPlane} CP + {cl.workers} workers
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <span style={{ color: c.questionMuted, fontSize: '13px' }}>No clusters configured</span>
              )}
            </Panel>

            {/* Domain Coverage */}
            <Panel title="Domain Coverage" c={c} isDark={isDark}>
              {Object.keys(categoryWeights).length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {Object.entries(categoryWeights).map(([cat, weight]) => {
                    const pct = totalWeight > 0 ? Math.round((weight / totalWeight) * 100) : 0;
                    return (
                      <div key={cat}>
                        <div style={{
                          display: 'flex', justifyContent: 'space-between',
                          fontSize: '12px', marginBottom: '3px',
                        }}>
                          <span style={{ color: c.questionText }}>{cat}</span>
                          <span style={{ color: isDark ? '#71717a' : '#94a3b8', fontFamily: "'SF Mono', Menlo, monospace" }}>
                            {pct}%
                          </span>
                        </div>
                        <div style={{
                          height: '5px', background: isDark ? '#2e2e35' : '#e4e4e7',
                          borderRadius: '3px', overflow: 'hidden',
                        }}>
                          <div style={{
                            height: '100%', borderRadius: '3px',
                            background: `linear-gradient(90deg, ${ACCENT}, ${ACCENT_HOVER})`,
                            width: `${pct}%`,
                            transition: 'width 0.3s',
                          }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <span style={{ color: c.questionMuted, fontSize: '13px' }}>Select an exam to see coverage</span>
              )}
            </Panel>
          </div>

          {/* Duration + Mode */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '14px',
            marginBottom: '20px',
          }}>
            <Panel title="Duration" c={c} isDark={isDark}>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {[1800, 3600, 5400, 7200, 9000].map((d) => (
                  <button
                    key={d}
                    onClick={() => setDuration(d)}
                    style={{
                      padding: '8px 16px', borderRadius: '6px', cursor: 'pointer',
                      fontSize: '13px',
                      border: `1px solid ${duration === d ? ACCENT : (isDark ? '#3f3f48' : '#d4d4d8')}`,
                      background: duration === d ? ACCENT : 'transparent',
                      color: duration === d ? 'white' : (isDark ? '#a1a1aa' : '#71717a'),
                      fontWeight: duration === d ? 600 : 400,
                      transition: 'all 0.15s',
                    }}
                  >
                    {d / 60}m
                  </button>
                ))}
              </div>
            </Panel>
            <Panel title="Mode" c={c} isDark={isDark}>
              <div style={{ display: 'flex', gap: '8px' }}>
                {([
                  { key: 'exam', label: 'Exam', desc: 'Timed, no hints' },
                  { key: 'practice', label: 'Practice', desc: 'Hints + solutions' },
                ] as const).map((m) => (
                  <button
                    key={m.key}
                    onClick={() => setMode(m.key)}
                    style={{
                      flex: 1, padding: '10px 14px', borderRadius: '8px',
                      cursor: 'pointer', textAlign: 'left',
                      border: `1px solid ${mode === m.key ? ACCENT : (isDark ? '#3f3f48' : '#d4d4d8')}`,
                      background: mode === m.key ? ACCENT : 'transparent',
                      color: mode === m.key ? 'white' : (isDark ? '#a1a1aa' : '#71717a'),
                      transition: 'all 0.15s',
                    }}
                  >
                    <div style={{ fontSize: '14px', fontWeight: 600 }}>{m.label}</div>
                    <div style={{ fontSize: '11px', marginTop: '2px', opacity: 0.7 }}>{m.desc}</div>
                  </button>
                ))}
              </div>
            </Panel>
          </div>

          {/* Questions preview */}
          {questions.length > 0 && (
            <Panel title={`Questions (${questions.length})`} c={c} isDark={isDark}
              extra={<span style={{ fontSize: '11px', color: isDark ? '#52525b' : '#94a3b8' }}>Scroll to preview</span>}>
              <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {questions.map((q, i) => (
                  <div key={q.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 0',
                    borderBottom: i < questions.length - 1 ? `1px solid ${isDark ? '#2e2e3540' : '#f4f4f5'}` : 'none',
                    fontSize: '13px',
                  }}>
                    <span style={{ color: c.questionText }}>{q.title}</span>
                    <span style={{ color: isDark ? '#52525b' : '#94a3b8', fontSize: '11px', whiteSpace: 'nowrap', marginLeft: '12px' }}>
                      {q.weight}pts &middot; {q.difficulty}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* Error */}
          {error && (
            <div style={{
              marginTop: '16px', marginBottom: '4px', padding: '10px 14px',
              background: c.errorBg, borderRadius: '6px',
              color: c.errorText, fontSize: '13px',
              border: `1px solid ${c.errorBorder}`,
            }}>
              {error}
            </div>
          )}

          {/* Progress Panel */}
          {loading && setupProgress && (
            <div style={{ marginTop: '16px' }}>
              <ClusterProgressPanel progress={setupProgress} c={c} isDark={isDark} />
            </div>
          )}

          {/* Start button */}
          <button
            onClick={() => startExam(duration)}
            disabled={loading || !allReady || !selectedExamId}
            style={{
              width: '100%', padding: '14px', marginTop: '20px',
              background: loading ? '#0891b2' : (allReady && selectedExamId)
                ? `linear-gradient(135deg, ${ACCENT}, #0891b2)`
                : (isDark ? '#3f3f48' : '#d4d4d8'),
              color: 'white', border: 'none', borderRadius: '8px',
              cursor: (allReady && !loading && selectedExamId) ? 'pointer' : 'not-allowed',
              fontSize: '16px', fontWeight: 700, opacity: loading ? 0.85 : 1,
              transition: 'all 0.2s',
            }}
          >
            {loading ? 'Setting Up Exam...' : selectedExam ? `Start ${selectedExam.name}` : 'Select an Exam'}
          </button>
            </>
          )}
        </div>
      </div>

      {/* ── Deck overlay: full-screen slide-in ── */}
      <div
        aria-hidden={activePane !== 'deck'}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 50,
          background: isDark ? '#0a0a0c' : '#f4f4f5',
          transform: activePane === 'deck' ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)',
          willChange: 'transform',
          pointerEvents: activePane === 'deck' ? 'auto' : 'none',
          boxShadow: activePane === 'deck' ? '0 0 40px rgba(0,0,0,0.35)' : 'none',
        }}
      >
        {deckMounted && <RevisionDeck onClose={() => setActivePane('exam')} />}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  );
}

/* ── Reusable building blocks ── */

function StatCard({ label, c, isDark, children }: {
  label: string; c: ReturnType<typeof colors>; isDark: boolean; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: c.cardBg,
      borderRadius: '10px',
      padding: '14px 16px',
      border: `1px solid ${c.cardBorder}`,
      position: 'relative',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{
        fontSize: '11px', color: isDark ? '#71717a' : '#94a3b8', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '6px',
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Panel({ title, c, isDark, children, extra }: {
  title: string; c: ReturnType<typeof colors>; isDark: boolean;
  children: React.ReactNode; extra?: React.ReactNode;
}) {
  return (
    <div style={{
      background: c.cardBg,
      borderRadius: '10px',
      padding: '16px 18px',
      border: `1px solid ${c.cardBorder}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: '11px', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.4px', color: isDark ? '#71717a' : '#94a3b8',
        marginBottom: '12px',
      }}>
        {title}
        {extra}
      </div>
      {children}
    </div>
  );
}

function PrereqDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span style={{ fontSize: '12px', display: 'flex', alignItems: 'center', gap: '3px' }}>
      <span style={{ color: ok ? '#34d399' : '#f87171', fontWeight: 700 }}>
        {ok ? '\u2713' : '\u2717'}
      </span>
      <span style={{ color: '#71717a' }}>{label}</span>
    </span>
  );
}

const clusterStateConfig: Record<ClusterState, { icon: string; color: string; label: string }> = {
  pending:   { icon: '\u25CB', color: '#a1a1aa', label: 'Pending' },
  checking:  { icon: '\u25CF', color: '#fbbf24', label: 'Checking' },
  resetting: { icon: '\u21BB', color: ACCENT, label: 'Resetting' },
  creating:  { icon: '\u25CF', color: '#fbbf24', label: 'Creating' },
  ready:     { icon: '\u2713', color: '#34d399', label: 'Ready' },
  error:     { icon: '\u2717', color: '#f87171', label: 'Error' },
};

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => {
    ref.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(ref.current);
  }, [startedAt]);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return <span>{mins}:{secs.toString().padStart(2, '0')}</span>;
}

function ClusterProgressPanel({ progress, c, isDark }: {
  progress: SetupProgress; c: ReturnType<typeof colors>; isDark: boolean;
}) {
  const clusterEntries = Object.values(progress.clusters);
  const readyCount = clusterEntries.filter(cl => cl.state === 'ready').length;
  const hasClusterData = clusterEntries.length > 0;

  let stepLabel = 'Initializing...';
  if (progress.step === 'cluster') stepLabel = 'Setting up clusters';
  else if (progress.step === 'prepare') stepLabel = 'Preparing environment';
  else if (progress.step === 'setup') stepLabel = 'Running question setups';
  else if (progress.step === 'ready') stepLabel = 'Ready!';
  else if (progress.step === 'error') stepLabel = 'Error';

  return (
    <div style={{
      padding: '16px', background: isDark ? '#0c1a2e' : '#eff6ff',
      borderRadius: '8px', border: `1px solid ${isDark ? '#1e3a5f' : '#bfdbfe'}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '16px', height: '16px', border: `2px solid ${ACCENT}`,
            borderTopColor: 'transparent', borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
          <span style={{ color: isDark ? '#67e8f9' : '#1d4ed8', fontSize: '14px', fontWeight: 600 }}>
            {stepLabel}
          </span>
        </div>
        {progress.startedAt && (
          <span style={{ color: c.questionMuted, fontSize: '12px', fontFamily: "'SF Mono', Menlo, monospace" }}>
            <ElapsedTimer startedAt={progress.startedAt} />
          </span>
        )}
      </div>

      {hasClusterData && (
        <div style={{ marginBottom: '10px' }}>
          <div style={{
            fontSize: '11px', color: c.questionMuted, marginBottom: '8px', fontWeight: 600,
            textTransform: 'uppercase', letterSpacing: '0.5px',
          }}>
            Clusters ({readyCount}/{clusterEntries.length} ready)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {clusterEntries.map((cl) => {
              const cfg = clusterStateConfig[cl.state];
              return (
                <div key={cl.name} style={{
                  display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 10px',
                  background: c.inputBg, borderRadius: '6px', border: `1px solid ${c.inputBorder}`,
                }}>
                  <span style={{
                    color: cfg.color, fontWeight: 700, fontSize: '14px', width: '18px', textAlign: 'center',
                    animation: (cl.state === 'creating' || cl.state === 'checking') ? 'pulse 1.5s ease-in-out infinite' : 'none',
                  }}>
                    {cfg.icon}
                  </span>
                  <span style={{
                    fontFamily: "'SF Mono', Menlo, monospace", fontSize: '12px',
                    color: c.questionText, flex: 1,
                  }}>
                    {cl.name}
                  </span>
                  <span style={{
                    fontSize: '11px', color: cfg.color, fontWeight: 500,
                    padding: '1px 8px', borderRadius: '3px',
                    background: cfg.color + '18',
                  }}>
                    {cfg.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ fontSize: '12px', color: c.questionMuted }}>
        {progress.message}
      </div>
    </div>
  );
}
