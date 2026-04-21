import { useEffect, useState, useRef } from 'react';
import { useExam, type SetupProgress, type ClusterState } from '../hooks/useExam';
import { useTheme, colors } from '../hooks/useTheme';
import { api } from '../api/client';
import { Dashboard } from './Dashboard';
import type { Prerequisites } from '../types';

const difficultyColors: Record<string, string> = {
  beginner: '#16a34a',
  intermediate: '#ea580c',
  advanced: '#dc2626',
  expert: '#7c3aed',
};

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

  useEffect(() => {
    loadExams();
    checkStatus();
  }, []);

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

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '24px',
      background: c.pageBg,
    }}>
      <div style={{
        maxWidth: '640px',
        width: '100%',
        background: c.cardBg,
        borderRadius: '12px',
        padding: '36px',
        boxShadow: isDark ? 'none' : '0 4px 24px rgba(0,0,0,0.08)',
        border: isDark ? `1px solid ${c.cardBorder}` : 'none',
        position: 'relative',
        maxHeight: '90vh',
        overflow: 'auto',
      }}>
        {/* Theme toggle */}
        <button
          onClick={toggle}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            position: 'absolute', top: '16px', right: '16px',
            padding: '4px 10px', background: c.btnSecondaryBg,
            color: c.btnSecondaryText, border: `1px solid ${c.btnSecondaryBorder}`,
            borderRadius: '4px', cursor: 'pointer', fontSize: '16px', lineHeight: 1,
          }}
        >
          {isDark ? '\u2600' : '\u263E'}
        </button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
          <div style={{
            width: '36px', height: '36px', background: '#326ce5', borderRadius: '8px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontWeight: 700, fontSize: '14px',
          }}>
            K8s
          </div>
          <h1 style={{ fontSize: '26px', fontWeight: 700, color: c.questionHeading }}>
            CKA Mock Exam
          </h1>
        </div>
        <p style={{ color: c.questionMuted, marginBottom: '28px', fontSize: '14px' }}>
          Certified Kubernetes Administrator Practice Environment
        </p>

        {/* Prerequisites */}
        <Section title="Prerequisites" c={c}>
          {checking ? (
            <p style={{ color: c.questionMuted, fontSize: '13px' }}>Checking...</p>
          ) : prereqs ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <StatusItem ok={prereqs.docker} label="Docker" error={prereqs.dockerErr} c={c} />
              <StatusItem ok={prereqs.kind} label="Kind" error={prereqs.kindErr} c={c} />
              <StatusItem ok={prereqs.kubectl} label="kubectl" error={prereqs.kubectlErr} c={c} />
            </div>
          ) : (
            <p style={{ color: '#dc2626', fontSize: '13px' }}>
              Could not check prerequisites. Is the server running?
            </p>
          )}
          <button onClick={checkStatus} style={{
            marginTop: '10px', padding: '4px 14px', background: c.btnSecondaryBg,
            color: c.questionMuted, border: `1px solid ${c.btnSecondaryBorder}`,
            borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
          }}>
            Refresh
          </button>
        </Section>

        {/* Exam Selection */}
        <Section title="Select Exam" c={c}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {exams.map((exam) => {
              const isSelected = exam.id === selectedExamId;
              const diffColor = difficultyColors[exam.difficulty] || '#64748b';
              return (
                <button
                  key={exam.id}
                  onClick={() => selectExam(exam.id)}
                  style={{
                    padding: '12px 16px',
                    background: isSelected ? '#326ce5' : c.btnSecondaryBg,
                    color: isSelected ? 'white' : c.btnSecondaryText,
                    border: isSelected ? '2px solid #326ce5' : `1px solid ${c.btnSecondaryBorder}`,
                    borderRadius: '8px',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ fontSize: '15px', fontWeight: 600 }}>{exam.name}</span>
                    <span style={{
                      fontSize: '10px', padding: '1px 6px', borderRadius: '3px',
                      background: isSelected ? 'rgba(255,255,255,0.2)' : diffColor,
                      color: 'white', fontWeight: 600, textTransform: 'uppercase',
                    }}>
                      {exam.difficulty}
                    </span>
                  </div>
                  <div style={{
                    fontSize: '12px', marginBottom: '6px',
                    opacity: isSelected ? 0.85 : 0.6,
                  }}>
                    {exam.description}
                  </div>
                  <div style={{
                    display: 'flex', gap: '12px', fontSize: '11px',
                    opacity: isSelected ? 0.8 : 0.5,
                  }}>
                    <span>{exam.questionCount} questions</span>
                    <span>{exam.totalWeight} pts</span>
                    <span>{exam.clusters.length} cluster{exam.clusters.length > 1 ? 's' : ''}</span>
                    <span>{Math.round(exam.duration / 60)} min</span>
                    <span>Pass: {exam.passScore}%</span>
                  </div>
                </button>
              );
            })}
          </div>
        </Section>

        {/* Cluster Info for selected exam */}
        {selectedExam && selectedExam.clusters.length > 0 && (
          <Section title={`Clusters (${selectedExam.clusters.length})`} c={c}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {selectedExam.clusters.map((cl) => (
                <div key={cl.name} style={{
                  padding: '6px 12px',
                  background: c.inputBg,
                  borderRadius: '6px',
                  border: `1px solid ${c.inputBorder}`,
                  fontSize: '12px',
                  color: c.questionText,
                }}>
                  <span style={{ fontWeight: 600, fontFamily: "'SF Mono', Menlo, monospace" }}>{cl.name}</span>
                  <span style={{ color: c.questionMuted, marginLeft: '8px' }}>
                    {cl.controlPlane} CP + {cl.workers} workers
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Questions preview */}
        {questions.length > 0 && (
          <Section title={`Questions (${questions.length})`} c={c}>
            <div style={{
              maxHeight: '160px', overflow: 'auto', background: c.inputBg,
              borderRadius: '6px', padding: '8px 12px', border: `1px solid ${c.inputBorder}`,
            }}>
              {questions.map((q, i) => (
                <div key={q.id} style={{
                  display: 'flex', justifyContent: 'space-between', padding: '5px 0',
                  fontSize: '13px',
                  borderBottom: i < questions.length - 1 ? `1px solid ${c.validationBorder}` : 'none',
                }}>
                  <span style={{ color: c.questionText }}>{q.title}</span>
                  <span style={{ color: c.questionMuted, flexShrink: 0, marginLeft: '12px', fontSize: '12px' }}>
                    {q.weight}pts · {q.difficulty}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Duration */}
        <Section title="Duration" c={c}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {[1800, 3600, 5400, 7200, 9000].map((d) => (
              <button
                key={d}
                onClick={() => setDuration(d)}
                style={{
                  padding: '7px 16px',
                  background: duration === d ? '#326ce5' : c.btnSecondaryBg,
                  color: duration === d ? 'white' : c.btnSecondaryText,
                  border: duration === d ? '1px solid #326ce5' : `1px solid ${c.btnSecondaryBorder}`,
                  borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
                  fontWeight: duration === d ? 600 : 400,
                }}
              >
                {d / 60} min
              </button>
            ))}
          </div>
        </Section>

        {/* Mode */}
        <Section title="Mode" c={c}>
          <div style={{ display: 'flex', gap: '8px' }}>
            {([
              { key: 'exam', label: 'Exam', desc: 'Timed, no hints or solutions' },
              { key: 'practice', label: 'Practice', desc: 'Hints + solutions after validation' },
            ] as const).map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                style={{
                  flex: 1, padding: '10px 14px',
                  background: mode === m.key ? '#326ce5' : c.btnSecondaryBg,
                  color: mode === m.key ? 'white' : c.btnSecondaryText,
                  border: mode === m.key ? '1px solid #326ce5' : `1px solid ${c.btnSecondaryBorder}`,
                  borderRadius: '6px', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{ fontSize: '14px', fontWeight: 600 }}>{m.label}</div>
                <div style={{ fontSize: '11px', marginTop: '2px', opacity: mode === m.key ? 0.85 : 0.6 }}>
                  {m.desc}
                </div>
              </button>
            ))}
          </div>
        </Section>

        {/* Error */}
        {error && (
          <div style={{
            marginBottom: '16px', padding: '10px 14px', background: c.errorBg,
            borderRadius: '6px', color: c.errorText, fontSize: '13px',
            border: `1px solid ${c.errorBorder}`,
          }}>
            {error}
          </div>
        )}

        {/* Progress Panel */}
        {loading && setupProgress && (
          <ClusterProgressPanel progress={setupProgress} c={c} />
        )}

        {/* Start button */}
        <button
          onClick={() => startExam(duration)}
          disabled={loading || !allReady || !selectedExamId}
          style={{
            width: '100%', padding: '12px',
            background: loading ? '#60a5fa' : (allReady && selectedExamId) ? '#326ce5' : (isDark ? '#475569' : '#cbd5e1'),
            color: 'white', border: 'none', borderRadius: '8px',
            cursor: (allReady && !loading && selectedExamId) ? 'pointer' : 'not-allowed',
            fontSize: '16px', fontWeight: 700, opacity: loading ? 0.85 : 1,
          }}
        >
          {loading ? 'Setting Up Exam...' : selectedExam ? `Start ${selectedExam.name}` : 'Select an Exam'}
        </button>

        {/* Past Attempts */}
        <button
          onClick={() => setShowDashboard(true)}
          style={{
            width: '100%', padding: '10px',
            background: 'transparent',
            color: c.questionMuted,
            border: `1px solid ${c.btnSecondaryBorder}`,
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 500,
            marginTop: '10px',
            transition: 'color 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#326ce5';
            e.currentTarget.style.borderColor = '#326ce5';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = c.questionMuted;
            e.currentTarget.style.borderColor = c.btnSecondaryBorder;
          }}
        >
          Past Attempts
        </button>

        <style>{`
          @keyframes spin { to { transform: rotate(360deg); } }
          @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        `}</style>
      </div>
    </div>
  );
}

function Section({ title, c, children }: { title: string; c: ReturnType<typeof colors>; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <h3 style={{
        fontSize: '13px', color: c.questionMuted, marginBottom: '10px',
        fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
      }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function StatusItem({ ok, label, error, c }: { ok: boolean; label: string; error?: string; c: ReturnType<typeof colors> }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
      <span style={{ color: ok ? '#16a34a' : '#dc2626', fontWeight: 700, fontSize: '15px' }}>
        {ok ? '\u2713' : '\u2717'}
      </span>
      <span style={{ color: c.statusText }}>{label}</span>
      {error && <span style={{ color: c.statusMuted, fontSize: '12px' }}>({error})</span>}
    </div>
  );
}

const clusterStateConfig: Record<ClusterState, { icon: string; color: string; label: string }> = {
  pending:   { icon: '\u25CB', color: '#94a3b8', label: 'Pending' },
  checking:  { icon: '\u25CF', color: '#f59e0b', label: 'Checking' },
  resetting: { icon: '\u21BB', color: '#3b82f6', label: 'Resetting' },
  creating:  { icon: '\u25CF', color: '#f59e0b', label: 'Creating' },
  ready:     { icon: '\u2713', color: '#16a34a', label: 'Ready' },
  error:     { icon: '\u2717', color: '#dc2626', label: 'Error' },
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

function ClusterProgressPanel({ progress, c }: { progress: SetupProgress; c: ReturnType<typeof colors> }) {
  const clusterEntries = Object.values(progress.clusters);
  const readyCount = clusterEntries.filter(cl => cl.state === 'ready').length;
  const hasClusterData = clusterEntries.length > 0;

  // Determine overall step label
  let stepLabel = 'Initializing...';
  if (progress.step === 'cluster') stepLabel = 'Setting up clusters';
  else if (progress.step === 'prepare') stepLabel = 'Preparing environment';
  else if (progress.step === 'setup') stepLabel = 'Running question setups';
  else if (progress.step === 'ready') stepLabel = 'Ready!';
  else if (progress.step === 'error') stepLabel = 'Error';

  return (
    <div style={{
      marginBottom: '16px', padding: '16px', background: c.progressBg,
      borderRadius: '8px', border: `1px solid ${c.progressBorder}`,
    }}>
      {/* Header: step label + elapsed time */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '16px', height: '16px', border: '2px solid #326ce5',
            borderTopColor: 'transparent', borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
          <span style={{ color: c.progressText, fontSize: '14px', fontWeight: 600 }}>{stepLabel}</span>
        </div>
        {progress.startedAt && (
          <span style={{ color: c.questionMuted, fontSize: '12px', fontFamily: "'SF Mono', Menlo, monospace" }}>
            <ElapsedTimer startedAt={progress.startedAt} />
          </span>
        )}
      </div>

      {/* Per-cluster status */}
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

      {/* Current action message */}
      <div style={{ fontSize: '12px', color: c.questionMuted }}>
        {progress.message}
      </div>
    </div>
  );
}
