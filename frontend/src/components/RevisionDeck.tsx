import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client';
import { useTheme, colors } from '../hooks/useTheme';
import type { DeckTopic, DeckTopicSummary } from '../types';

const DOMAIN_ORDER: { id: string; label: string; weight: string }[] = [
  { id: 'cluster-architecture', label: 'Cluster Architecture',    weight: '25%' },
  { id: 'workloads',            label: 'Workloads & Scheduling',  weight: '15%' },
  { id: 'services-networking',  label: 'Services & Networking',   weight: '20%' },
  { id: 'storage',              label: 'Storage',                 weight: '10%' },
  { id: 'troubleshooting',      label: 'Troubleshooting',         weight: '30%' },
];
const UNGROUPED_DOMAIN = { id: '__other__', label: 'Other', weight: '' };

export function RevisionDeck({ onClose }: { onClose?: () => void } = {}) {
  const { isDark, toggle } = useTheme();
  const c = colors(isDark);
  const [topics, setTopics] = useState<DeckTopicSummary[]>([]);
  const [currentTopicId, setCurrentTopicId] = useState<string | null>(null);
  const [currentTopic, setCurrentTopic] = useState<DeckTopic | null>(null);
  const [currentSubtopicId, setCurrentSubtopicId] = useState<string | null>(null);
  const [loadingTopics, setLoadingTopics] = useState(true);
  const [loadingTopic, setLoadingTopic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groupedTopics = useMemo(() => {
    const byDomain = new Map<string, DeckTopicSummary[]>();
    for (const t of topics) {
      const d = t.domain || UNGROUPED_DOMAIN.id;
      const list = byDomain.get(d) || [];
      list.push(t);
      byDomain.set(d, list);
    }
    const groups: { id: string; label: string; weight: string; topics: DeckTopicSummary[] }[] = [];
    for (const d of DOMAIN_ORDER) {
      const list = byDomain.get(d.id);
      if (list && list.length > 0) {
        groups.push({ ...d, topics: list });
      }
    }
    const other = byDomain.get(UNGROUPED_DOMAIN.id);
    if (other && other.length > 0) {
      groups.push({ ...UNGROUPED_DOMAIN, topics: other });
    }
    return groups;
  }, [topics]);

  const toggleDomain = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    void loadTopics();
  }, []);

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
      }
      const isLeft = e.key === 'ArrowLeft' || e.key === 'h';
      const isRight = e.key === 'ArrowRight' || e.key === 'l';
      if (!isLeft && !isRight) return;
      const list = currentTopic?.subtopics || [];
      if (list.length < 2) return;
      const idx = list.findIndex((s) => s.id === currentSubtopicId);
      const cur = idx >= 0 ? idx : 0;
      if (isLeft && cur > 0) {
        e.preventDefault();
        setCurrentSubtopicId(list[cur - 1].id);
      } else if (isRight && cur < list.length - 1) {
        e.preventDefault();
        setCurrentSubtopicId(list[cur + 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentTopic, currentSubtopicId]);

  const loadTopics = async () => {
    setLoadingTopics(true);
    setError(null);
    try {
      const list = await api.listDeckTopics();
      setTopics(list);
      if (list.length > 0) {
        await loadTopic(list[0].id);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load deck topics');
    } finally {
      setLoadingTopics(false);
    }
  };

  const loadTopic = async (id: string) => {
    setCurrentTopicId(id);
    setLoadingTopic(true);
    setError(null);
    try {
      const topic = await api.getDeckTopic(id);
      setCurrentTopic(topic);
      setCurrentSubtopicId(topic.subtopics[0]?.id || null);
    } catch (e: any) {
      setError(e.message || 'Failed to load deck topic');
      setCurrentTopic(null);
      setCurrentSubtopicId(null);
    } finally {
      setLoadingTopic(false);
    }
  };

  const subtopics = currentTopic?.subtopics || [];
  const currentIndex = subtopics.findIndex((s) => s.id === currentSubtopicId);
  const effectiveIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentSubtopic = subtopics[effectiveIndex] || null;
  const prevSubtopic = effectiveIndex > 0 ? subtopics[effectiveIndex - 1] : null;
  const nextSubtopic = effectiveIndex < subtopics.length - 1 ? subtopics[effectiveIndex + 1] : null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      width: '100%',
      background: isDark ? '#0a0a0c' : '#f4f4f5',
    }}>
      {onClose && (
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
            <button
              onClick={onClose}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: 'transparent',
                color: c.questionMuted,
                border: `1px solid ${c.cardBorder}`,
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#06b6d4'; e.currentTarget.style.borderColor = '#06b6d4'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = c.questionMuted; e.currentTarget.style.borderColor = c.cardBorder; }}
            >
              <span style={{ fontSize: '14px', lineHeight: 1 }}>&larr;</span> Back to Exam Setup
            </button>
            <span style={{ fontSize: '17px', fontWeight: 700, color: c.questionHeading }}>
              Revision Deck
            </span>
            <span style={{
              fontSize: '10px',
              padding: '2px 8px',
              borderRadius: '999px',
              background: isDark ? '#0b1d24' : '#ecfeff',
              color: isDark ? '#67e8f9' : '#0e7490',
              border: `1px solid ${isDark ? '#134253' : '#a5f3fc'}`,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.4px',
            }}>
              No Docker required
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '11px', color: c.questionMuted }}>
              ← / → subtopics &middot; Esc to exit
            </span>
            <button
              onClick={toggle}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              style={{
                padding: '6px 10px', background: 'transparent',
                color: c.questionMuted, border: `1px solid ${c.cardBorder}`,
                borderRadius: '6px', cursor: 'pointer', fontSize: '14px', lineHeight: 1,
              }}
            >
              {isDark ? '☀' : '☾'}
            </button>
          </div>
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: '300px minmax(0, 1fr)',
        gap: '16px',
        padding: '16px',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
      }}>
      <div style={{
        background: c.cardBg,
        borderRadius: '10px',
        border: `1px solid ${c.cardBorder}`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}>
        <div style={{
          padding: '12px 14px',
          fontSize: '11px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: isDark ? '#71717a' : '#94a3b8',
          borderBottom: `1px solid ${c.cardBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>CKA Domains</span>
          <span style={{ fontSize: '10px', fontWeight: 600, color: c.questionMuted }}>
            {topics.length} {topics.length === 1 ? 'topic' : 'topics'}
          </span>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loadingTopics && (
            <div style={{ padding: '16px', color: c.questionMuted, fontSize: '13px' }}>
              Loading deck topics...
            </div>
          )}

          {!loadingTopics && groupedTopics.map((group) => {
            const isCollapsed = collapsed.has(group.id);
            return (
              <div key={group.id}>
                <button
                  onClick={() => toggleDomain(group.id)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '10px 14px',
                    border: 'none',
                    borderBottom: `1px solid ${isDark ? '#2e2e3540' : '#f4f4f5'}`,
                    background: isDark ? '#0f0f13' : '#f9fafb',
                    color: c.questionHeading,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{
                    fontSize: '10px',
                    width: '10px',
                    color: c.questionMuted,
                    transition: 'transform 0.15s',
                    transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                  }}>▼</span>
                  <span style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    flex: 1,
                  }}>
                    {group.label}
                  </span>
                  {group.weight && (
                    <span style={{
                      fontSize: '10px',
                      padding: '1px 6px',
                      borderRadius: '999px',
                      background: isDark ? '#111114' : '#ffffff',
                      border: `1px solid ${c.cardBorder}`,
                      color: c.questionMuted,
                      fontWeight: 600,
                    }}>
                      {group.weight}
                    </span>
                  )}
                  <span style={{
                    fontSize: '10px',
                    color: c.questionMuted,
                    fontWeight: 600,
                    minWidth: '18px',
                    textAlign: 'right',
                  }}>
                    {group.topics.length}
                  </span>
                </button>
                {!isCollapsed && group.topics.map((topic) => {
                  const selected = topic.id === currentTopicId;
                  return (
                    <button
                      key={topic.id}
                      onClick={() => void loadTopic(topic.id)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        padding: '10px 14px 10px 30px',
                        border: 'none',
                        borderLeft: `3px solid ${selected ? '#06b6d4' : 'transparent'}`,
                        borderBottom: `1px solid ${isDark ? '#2e2e3540' : '#f4f4f5'}`,
                        background: selected ? (isDark ? '#1c1c21' : '#fafafa') : 'transparent',
                        color: selected ? c.questionHeading : c.questionText,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                      onMouseEnter={(e) => {
                        if (!selected) e.currentTarget.style.background = isDark ? '#1c1c2140' : '#fafafa';
                      }}
                      onMouseLeave={(e) => {
                        if (!selected) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span style={{ fontSize: '13px', fontWeight: selected ? 700 : 500 }}>
                        {topic.title}
                      </span>
                      <span style={{
                        fontSize: '10px',
                        color: c.questionMuted,
                        fontWeight: 600,
                        flexShrink: 0,
                      }}>
                        {topic.subtopicCount}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
      }}>
        {error && (
          <div style={{
            padding: '10px 14px',
            background: c.errorBg,
            border: `1px solid ${c.errorBorder}`,
            borderRadius: '6px',
            color: c.errorText,
            fontSize: '13px',
          }}>
            {error}
          </div>
        )}

        {currentTopic && (
          <>
            <div style={{
              background: c.cardBg,
              borderRadius: '10px',
              border: `1px solid ${c.cardBorder}`,
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              flexWrap: 'wrap',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexShrink: 0,
              }}>
                <div style={{ fontSize: '18px', fontWeight: 700, color: c.questionHeading }}>
                  {currentTopic.title}
                </div>
                {loadingTopic && (
                  <span style={{ fontSize: '11px', color: c.questionMuted }}>
                    Loading…
                  </span>
                )}
              </div>
              <div style={{
                width: '1px',
                height: '20px',
                background: c.cardBorder,
                flexShrink: 0,
              }} />
              <div style={{
                display: 'flex',
                gap: '6px',
                flexWrap: 'wrap',
                flex: 1,
                minWidth: 0,
              }}>
                {currentTopic.subtopics.map((subtopic) => {
                  const selected = subtopic.id === currentSubtopicId;
                  return (
                    <button
                      key={subtopic.id}
                      onClick={() => setCurrentSubtopicId(subtopic.id)}
                      title={subtopic.summary || subtopic.title}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: `1px solid ${selected ? '#06b6d4' : c.cardBorder}`,
                        background: selected ? (isDark ? '#0b1d24' : '#ecfeff') : 'transparent',
                        color: selected ? (isDark ? '#67e8f9' : '#0e7490') : c.questionText,
                        cursor: 'pointer',
                        fontSize: '12px',
                        fontWeight: selected ? 700 : 500,
                        whiteSpace: 'nowrap',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        if (!selected) e.currentTarget.style.borderColor = '#06b6d4';
                      }}
                      onMouseLeave={(e) => {
                        if (!selected) e.currentTarget.style.borderColor = c.cardBorder;
                      }}
                    >
                      {subtopic.title}
                    </button>
                  );
                })}
              </div>
            </div>

            {currentSubtopic && (
              <div style={{
                background: c.cardBg,
                borderRadius: '10px',
                border: `1px solid ${c.cardBorder}`,
                padding: '18px 20px',
                overflowY: 'auto',
                overflowX: 'hidden',
                minWidth: 0,
                flex: 1,
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  marginBottom: '8px',
                  flexWrap: 'wrap',
                }}>
                  <div style={{ fontSize: '22px', fontWeight: 700, color: c.questionHeading }}>
                    {currentSubtopic.title}
                  </div>
                  <div style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '999px',
                    background: isDark ? '#111114' : '#f4f4f5',
                    color: c.questionMuted,
                    fontWeight: 600,
                  }}>
                    {effectiveIndex + 1} / {subtopics.length}
                  </div>
                </div>
                {currentSubtopic.summary && (
                  <div style={{ fontSize: '13px', lineHeight: 1.6, color: c.questionMuted, marginBottom: '12px' }}>
                    {currentSubtopic.summary}
                  </div>
                )}
                {currentSubtopic.tags && currentSubtopic.tags.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '16px' }}>
                    {currentSubtopic.tags.map((tag) => (
                      <span key={tag} style={{
                        fontSize: '10px',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        background: isDark ? '#0b1d24' : '#ecfeff',
                        color: isDark ? '#67e8f9' : '#0e7490',
                        border: `1px solid ${isDark ? '#134253' : '#a5f3fc'}`,
                        fontWeight: 600,
                      }}>
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                <MarkdownBody content={currentSubtopic.content} c={c} />

                {(prevSubtopic || nextSubtopic) && (
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '12px',
                    marginTop: '24px',
                    paddingTop: '16px',
                    borderTop: `1px solid ${c.cardBorder}`,
                  }}>
                    {prevSubtopic ? (
                      <button
                        onClick={() => setCurrentSubtopicId(prevSubtopic.id)}
                        style={{
                          padding: '10px 14px',
                          borderRadius: '8px',
                          border: `1px solid ${c.cardBorder}`,
                          background: 'transparent',
                          color: c.questionText,
                          cursor: 'pointer',
                          textAlign: 'left',
                          flex: 1,
                          maxWidth: '48%',
                        }}
                      >
                        <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', color: c.questionMuted, marginBottom: '4px' }}>
                          ← Previous
                        </div>
                        <div style={{ fontSize: '13px', fontWeight: 700 }}>
                          {prevSubtopic.title}
                        </div>
                      </button>
                    ) : <div style={{ flex: 1, maxWidth: '48%' }} />}
                    {nextSubtopic ? (
                      <button
                        onClick={() => setCurrentSubtopicId(nextSubtopic.id)}
                        style={{
                          padding: '10px 14px',
                          borderRadius: '8px',
                          border: `1px solid ${c.cardBorder}`,
                          background: 'transparent',
                          color: c.questionText,
                          cursor: 'pointer',
                          textAlign: 'right',
                          flex: 1,
                          maxWidth: '48%',
                        }}
                      >
                        <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', color: c.questionMuted, marginBottom: '4px' }}>
                          Next →
                        </div>
                        <div style={{ fontSize: '13px', fontWeight: 700 }}>
                          {nextSubtopic.title}
                        </div>
                      </button>
                    ) : <div style={{ flex: 1, maxWidth: '48%' }} />}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      </div>
    </div>
  );
}

function MarkdownBody({ content, c }: { content: string; c: ReturnType<typeof colors> }) {
  return (
    <div className="revision-deck-content" style={{
      fontSize: '14px',
      lineHeight: '1.75',
      color: c.questionText,
    }}>
      <style>{`
        .revision-deck-content {
          min-width: 0;
          max-width: 100%;
          overflow-wrap: anywhere;
          word-break: break-word;
        }
        .revision-deck-content ul,
        .revision-deck-content ol {
          padding-left: 28px;
          margin: 8px 0 12px;
        }
        .revision-deck-content li {
          margin-bottom: 6px;
          padding-left: 4px;
        }
        .revision-deck-content p {
          margin-bottom: 10px;
        }
        .revision-deck-content h2,
        .revision-deck-content h3 {
          color: ${c.questionHeading};
          margin: 18px 0 8px;
        }
        .revision-deck-content strong {
          color: ${c.questionHeading};
          font-weight: 700;
        }
        .revision-deck-content pre {
          max-width: 100%;
          overflow-x: auto;
          white-space: pre;
          word-break: normal;
          overflow-wrap: normal;
        }
        .revision-deck-content pre code {
          white-space: pre;
          word-break: normal;
          overflow-wrap: normal;
        }
        .revision-deck-content table {
          display: block;
          max-width: 100%;
          overflow-x: auto;
          border-collapse: collapse;
          margin: 12px 0;
        }
        .revision-deck-content th,
        .revision-deck-content td {
          border: 1px solid ${c.cardBorder};
          padding: 6px 10px;
          font-size: 13px;
          text-align: left;
        }
        .revision-deck-content th {
          background: ${c.codeBg};
          color: ${c.questionHeading};
          font-weight: 700;
        }
      `}</style>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ children, className }) => {
            const text = Array.isArray(children) ? children.join('') : String(children ?? '');
            const isBlock = text.includes('\n') || Boolean(className && /language-/.test(className));
            if (isBlock) {
              return <code className={className}>{children}</code>;
            }
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
              fontFamily: "'SF Mono', Menlo, Consolas, monospace",
            }}>
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
