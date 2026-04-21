import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { GetTerminalURL } from '../api/client';

export function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', monospace",
      theme: {
        background: '#000000',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;

    term.write('Connecting to terminal...\r\n');

    // Get WebSocket URL from Go backend (starts local server if needed)
    let cancelled = false;

    GetTerminalURL().then((wsUrl) => {
      if (cancelled) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        term.clear();
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      };

      ws.onmessage = (event) => {
        const data = event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : event.data;
        term.write(data);
      };

      ws.onclose = () => {
        term.write('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n');
      };

      ws.onerror = () => {
        term.write('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n');
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        const dims = fitAddon.proposeDimensions();
        if (dims && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      });
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      // Store cleanup for this path
      (term as any)._resizeObserver = resizeObserver;
    }).catch((err) => {
      if (!cancelled) {
        const msg = err?.message || String(err);
        setError(msg);
        term.write(`\r\n\x1b[31mFailed to start terminal: ${msg}\x1b[0m\r\n`);
      }
    });

    return () => {
      cancelled = true;
      const ro = (term as any)._resizeObserver as ResizeObserver | undefined;
      ro?.disconnect();
      wsRef.current?.close();
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        background: '#000000',
        padding: '4px',
      }}
    />
  );
}
