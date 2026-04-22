import { useEffect } from 'react';
import { useExam } from './hooks/useExam';
import { useTheme, colors } from './hooks/useTheme';
import { ExamSetup } from './components/ExamSetup';
import { Header } from './components/Header';
import { QuestionPanel } from './components/QuestionPanel';
import { Terminal } from './components/Terminal';
import { DocsBrowser } from './components/DocsBrowser';
import { QuestionNav } from './components/QuestionNav';
import { ScoreCard } from './components/ScoreCard';
import { useState } from 'react';

export function App() {
  const { view, loadExams, gradingMessage } = useExam();
  const { isDark } = useTheme();
  const c = colors(isDark);
  const [rightTab, setRightTab] = useState<'terminal' | 'docs'>('terminal');

  useEffect(() => {
    loadExams();
  }, [loadExams]);

  if (view === 'setup') return <ExamSetup />;
  if (view === 'score') return <ScoreCard />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: c.pageBg }}>
      <Header onToggleDocs={() => setRightTab(rightTab === 'docs' ? 'terminal' : 'docs')} />

      {/* Grading overlay — shown while FinishExam validates all questions */}
      {gradingMessage && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
        }}>
          <div style={{
            background: isDark ? '#1c1c21' : '#ffffff',
            borderRadius: '12px',
            padding: '40px 48px',
            textAlign: 'center',
            boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
            maxWidth: '480px',
            width: '90%',
          }}>
            <div style={{
              width: '48px',
              height: '48px',
              border: '4px solid #06b6d4',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              margin: '0 auto 20px',
            }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{
              fontSize: '18px',
              fontWeight: 700,
              color: isDark ? '#fafafa' : '#1e293b',
              marginBottom: '8px',
            }}>
              Grading Your Exam
            </div>
            <div style={{
              fontSize: '14px',
              color: isDark ? '#a1a1aa' : '#71717a',
              lineHeight: 1.5,
            }}>
              {gradingMessage}
            </div>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left: Question panel */}
        <div style={{
          width: '40%',
          display: 'flex',
          flexDirection: 'column',
          borderRight: `2px solid ${c.cardBorder}`,
          background: c.questionBg,
          overflow: 'hidden',
        }}>
          <QuestionPanel />
          <QuestionNav />
        </div>

        {/* Right: Terminal / Docs (always dark) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#000000' }}>
          {/* Tab bar */}
          <div style={{
            display: 'flex',
            background: c.tabBarBg,
            borderBottom: `1px solid ${c.tabBorder}`,
          }}>
            <button
              onClick={() => setRightTab('terminal')}
              style={{
                padding: '8px 24px',
                background: rightTab === 'terminal' ? c.tabActive : 'transparent',
                color: rightTab === 'terminal' ? c.tabActiveText : c.tabText,
                border: 'none',
                borderBottom: rightTab === 'terminal' ? '2px solid #06b6d4' : '2px solid transparent',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 500,
              }}
            >
              Terminal
            </button>
            <button
              onClick={() => setRightTab('docs')}
              style={{
                padding: '8px 24px',
                background: rightTab === 'docs' ? c.tabActive : 'transparent',
                color: rightTab === 'docs' ? c.tabActiveText : c.tabText,
                border: 'none',
                borderBottom: rightTab === 'docs' ? '2px solid #06b6d4' : '2px solid transparent',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 500,
              }}
            >
              K8s Docs
            </button>
          </div>
          <div style={{ flex: 1, position: 'relative' }}>
            <div style={{
              position: 'absolute', inset: 0,
              display: rightTab === 'terminal' ? 'flex' : 'none',
            }}>
              <Terminal />
            </div>
            <div style={{
              position: 'absolute', inset: 0,
              display: rightTab === 'docs' ? 'flex' : 'none',
            }}>
              <DocsBrowser visible={rightTab === 'docs'} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
