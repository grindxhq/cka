import { useState } from 'react';
import { useTimer } from '../hooks/useTimer';
import { useExam } from '../hooks/useExam';
import { useTheme, colors } from '../hooks/useTheme';

interface HeaderProps {
  onToggleDocs: () => void;
}

export function Header({ onToggleDocs }: HeaderProps) {
  const { display, remaining } = useTimer();
  const { questions, currentQuestionId, examStatus, finishExam } = useExam();
  const { isDark, toggle } = useTheme();
  const c = colors(isDark);
  const [showConfirm, setShowConfirm] = useState(false);

  const currentIndex = questions.findIndex((q) => q.id === currentQuestionId);
  const totalQuestions = questions.length;
  const passedCount = examStatus
    ? Object.values(examStatus.questions).filter((q) => q.passed).length
    : 0;

  const timerUrgent = remaining > 0 && remaining < 300;

  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 20px',
      background: isDark ? '#1e293b' : '#326ce5',
      borderBottom: isDark ? '1px solid #334155' : 'none',
      minHeight: '48px',
      color: 'white',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <span style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '0.5px' }}>
          CKA Mock Exam
        </span>
        <span style={{ fontSize: '13px', opacity: 0.85 }}>
          Question {currentIndex + 1} of {totalQuestions}
        </span>
        <span style={{ fontSize: '13px', opacity: 0.85 }}>
          Passed: {passedCount}/{totalQuestions}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{
          fontFamily: 'monospace',
          fontSize: '16px',
          fontWeight: 700,
          background: timerUrgent ? '#dc2626' : 'rgba(255,255,255,0.15)',
          padding: '4px 14px',
          borderRadius: '4px',
          minWidth: '90px',
          textAlign: 'center',
        }}>
          {display}
        </span>

        <button
          onClick={onToggleDocs}
          style={{
            padding: '5px 14px',
            background: 'rgba(255,255,255,0.15)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.3)',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
          }}
        >
          K8s Docs
        </button>

        {/* Dark mode toggle */}
        <button
          onClick={toggle}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            padding: '5px 10px',
            background: 'rgba(255,255,255,0.15)',
            color: 'white',
            border: '1px solid rgba(255,255,255,0.3)',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px',
            lineHeight: 1,
          }}
        >
          {isDark ? '\u2600' : '\u263E'}
        </button>

        <button
          onClick={() => setShowConfirm(true)}
          style={{
            padding: '5px 14px',
            background: '#dc2626',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 600,
          }}
        >
          End Exam
        </button>
      </div>

      {/* End Exam confirmation dialog */}
      {showConfirm && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
        }}>
          <div style={{
            background: c.cardBg,
            borderRadius: '8px',
            padding: '28px',
            maxWidth: '420px',
            width: '90%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
            border: `1px solid ${c.cardBorder}`,
          }}>
            <h3 style={{ margin: '0 0 12px', fontSize: '18px', color: c.questionHeading, fontWeight: 700 }}>
              End Exam?
            </h3>
            <p style={{ margin: '0 0 24px', color: c.questionMuted, fontSize: '14px', lineHeight: 1.6 }}>
              This will end your exam session and calculate your final score.
              You cannot resume after ending.
            </p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowConfirm(false)}
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
                Continue Exam
              </button>
              <button
                onClick={() => {
                  setShowConfirm(false);
                  finishExam();
                }}
                style={{
                  padding: '8px 20px',
                  background: '#dc2626',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 600,
                }}
              >
                End Exam
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
