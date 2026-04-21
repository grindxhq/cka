import { useExam } from '../hooks/useExam';
import { useTheme, colors } from '../hooks/useTheme';

export function QuestionNav() {
  const { questions, currentQuestionId, examStatus, selectQuestion, flaggedQuestions } = useExam();
  const { isDark } = useTheme();
  const c = colors(isDark);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '10px 16px',
      background: c.navBg,
      borderTop: `1px solid ${c.navBorder}`,
      flexWrap: 'wrap',
    }}>
      {questions.map((q, i) => {
        const isCurrent = q.id === currentQuestionId;
        const status = examStatus?.questions[q.id];
        const passed = status?.passed;
        const attempted = status?.attempted;
        const isFlagged = flaggedQuestions.has(q.id);

        let bg = c.navPillDefault;
        if (passed) bg = '#16a34a';
        else if (attempted) bg = '#dc2626';

        return (
          <button
            key={q.id}
            onClick={() => selectQuestion(q.id)}
            title={`${q.title} (${q.weight}%)${isFlagged ? ' — Flagged' : ''}`}
            style={{
              width: '30px',
              height: '30px',
              borderRadius: '50%',
              background: bg,
              color: 'white',
              border: isCurrent ? '2px solid #326ce5' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: isCurrent ? '0 0 0 2px rgba(50,108,229,0.3)' : 'none',
              position: 'relative',
            }}
          >
            {i + 1}
            {isFlagged && (
              <span style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: '#f59e0b',
                border: `2px solid ${c.navBg}`,
              }} />
            )}
          </button>
        );
      })}
    </div>
  );
}
