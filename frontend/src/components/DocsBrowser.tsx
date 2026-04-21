import { useRef, useState, useCallback, useEffect } from 'react';
import { GetDocsProxyURL } from '../api/client';

// Base URL of the transparent proxy (http://127.0.0.1:PORT).
let proxyOrigin = '';

function toProxyUrl(realUrl: string): string {
  if (!proxyOrigin) return '';
  try {
    const u = new URL(realUrl);
    if (u.hostname === 'kubernetes.io') {
      return proxyOrigin + u.pathname + u.search;
    }
    return proxyOrigin + '/docs/';
  } catch {
    if (realUrl.startsWith('/')) return proxyOrigin + realUrl;
    return proxyOrigin + '/docs/';
  }
}

function toRealUrl(proxyUrl: string): string {
  if (!proxyOrigin) return proxyUrl;
  try {
    const u = new URL(proxyUrl);
    return 'https://kubernetes.io' + u.pathname + u.search;
  } catch {
    return proxyUrl;
  }
}

/** Call Go backend to open URL in system browser */
function openInSystemBrowser(url: string) {
  try {
    (window as any)['go']['main']['App']['OpenInBrowser'](url);
  } catch {
    window.open(url, '_blank');
  }
}

export function DocsBrowser({ visible }: { visible?: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [displayUrl, setDisplayUrl] = useState('https://kubernetes.io/docs/');
  const [inputUrl, setInputUrl] = useState(displayUrl);
  const [searchQuery, setSearchQuery] = useState('');
  const [iframeSrc, setIframeSrc] = useState('');
  const [proxyReady, setProxyReady] = useState(false);
  const hasActivated = useRef(false);

  useEffect(() => {
    if (!visible || proxyReady) return;
    GetDocsProxyURL().then((baseUrl) => {
      proxyOrigin = baseUrl;
      setProxyReady(true);
    }).catch((err) => {
      console.error('Failed to start docs proxy:', err);
    });
  }, [visible, proxyReady]);

  useEffect(() => {
    if (visible && proxyReady && !hasActivated.current) {
      hasActivated.current = true;
      setIframeSrc(toProxyUrl(displayUrl));
    }
  }, [visible, proxyReady, displayUrl]);

  // Listen for URL change messages from the iframe
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data && e.data.type === 'nav:url' && typeof e.data.url === 'string') {
        const real = toRealUrl(e.data.url);
        setDisplayUrl(real);
        setInputUrl(real);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const navigate = useCallback((realUrl: string) => {
    const proxy = toProxyUrl(realUrl);
    setDisplayUrl(realUrl);
    setInputUrl(realUrl);
    setIframeSrc(proxy);
  }, []);

  const sendToIframe = useCallback((msg: string) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  // Search opens in system browser — matches CKA exam experience
  const handleSearch = useCallback((q: string) => {
    if (!q.trim()) return;
    openInSystemBrowser('https://kubernetes.io/search/?q=' + encodeURIComponent(q.trim()));
  }, []);

  // "Open in Browser" opens the current page
  const openCurrentInBrowser = useCallback(() => {
    openInSystemBrowser(displayUrl);
  }, [displayUrl]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
      {/* Navigation bar */}
      <div style={{
        display: 'flex',
        gap: '4px',
        padding: '6px 8px',
        background: '#1e293b',
        borderBottom: '1px solid #334155',
        alignItems: 'center',
      }}>
        <button onClick={() => sendToIframe('nav:back')} style={navBtnStyle} title="Back">&#8592;</button>
        <button onClick={() => sendToIframe('nav:forward')} style={navBtnStyle} title="Forward">&#8594;</button>
        <button onClick={() => sendToIframe('nav:reload')} style={navBtnStyle} title="Reload">&#8635;</button>

        {/* URL bar */}
        <form
          onSubmit={(e) => { e.preventDefault(); navigate(inputUrl); }}
          style={{ flex: 1, display: 'flex' }}
        >
          <input
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            placeholder="https://kubernetes.io/docs/"
            style={urlInputStyle}
          />
        </form>

        {/* Search — opens in real browser like CKA exam */}
        <form
          onSubmit={(e) => { e.preventDefault(); handleSearch(searchQuery); }}
          style={{ display: 'flex', gap: '2px' }}
        >
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search docs..."
            style={{
              ...urlInputStyle,
              width: '140px',
              flex: 'none',
            }}
          />
          <button
            type="submit"
            style={{ ...navBtnStyle, fontSize: '12px' }}
            title="Search kubernetes.io (opens in browser)"
          >
            &#128269;
          </button>
        </form>

        <button
          onClick={openCurrentInBrowser}
          style={{
            ...navBtnStyle,
            background: '#326ce5',
            fontSize: '11px',
            padding: '4px 10px',
            whiteSpace: 'nowrap',
          }}
          title="Open this page in your system browser"
        >
          Open in Browser &#8599;
        </button>
      </div>

      {/* Content */}
      {!proxyReady && visible ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>
          Starting docs proxy...
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          style={{ flex: 1, border: 'none', background: 'white' }}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          title="Kubernetes Documentation"
        />
      )}
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  background: '#334155',
  color: '#e2e8f0',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '14px',
  lineHeight: 1,
};

const urlInputStyle: React.CSSProperties = {
  flex: 1,
  padding: '4px 8px',
  background: '#0f172a',
  border: '1px solid #334155',
  borderRadius: '4px',
  color: '#e2e8f0',
  fontSize: '12px',
  outline: 'none',
};
