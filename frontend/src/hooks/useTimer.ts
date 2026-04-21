import { useEffect, useState } from 'react';
import { useExam } from './useExam';

export function useTimer() {
  const { examStatus, refreshStatus, view } = useExam();
  const [remaining, setRemaining] = useState(0);

  // Sync with server on mount and periodically
  useEffect(() => {
    if (view !== 'exam') return;
    refreshStatus();
    const interval = setInterval(refreshStatus, 15000); // sync every 15s
    return () => clearInterval(interval);
  }, [view, refreshStatus]);

  // Update from server status
  useEffect(() => {
    if (examStatus) {
      setRemaining(examStatus.timeRemaining);
    }
  }, [examStatus]);

  // Local countdown every second.
  // Dep: `remaining > 0` is intentional — re-create interval only when
  // transitioning between 0 and positive, not on every tick.
  const isRunning = view === 'exam' && remaining > 0;
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  const seconds = remaining % 60;
  const display = `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return { remaining, display };
}
