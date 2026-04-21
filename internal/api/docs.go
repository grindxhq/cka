package api

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var docsClient = &http.Client{
	Timeout: 15 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// KubeDocsProxy is a transparent reverse proxy for kubernetes.io.
//
// Every request path maps 1:1 to the same path on kubernetes.io, so
// relative URLs, dynamic JS imports (Pagefind), and search all work
// naturally without URL rewriting. The only changes we make:
//
//   - Strip X-Frame-Options / CSP so the page renders inside an iframe
//   - Convert absolute "https://kubernetes.io/..." URLs to relative "/" in HTML/CSS
//   - Inject a click interceptor that blocks navigation to external sites
//   - Force Pagefind search instead of Google CSE (which needs cookies/ATS)
func KubeDocsProxy(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if path == "" {
		path = "/"
	}

	// Serve a custom search page that uses Pagefind with explicit paths.
	// kubernetes.io's search page relies on Google CSE + complex JS that
	// doesn't work in an iframe. Our custom page uses Pagefind directly.
	if path == "/search/" || path == "/search" {
		serveSearchPage(w, r)
		return
	}

	targetURL := "https://kubernetes.io" + path
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	req, err := http.NewRequestWithContext(r.Context(), "GET", targetURL, nil)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")
	req.Header.Set("Accept", r.Header.Get("Accept"))
	req.Header.Set("Accept-Language", r.Header.Get("Accept-Language"))

	resp, err := docsClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	defer resp.Body.Close()

	// ── Handle redirects — keep them relative ──
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		if loc := resp.Header.Get("Location"); loc != "" {
			w.Header().Set("Location", rewriteLocation(loc))
			w.WriteHeader(resp.StatusCode)
			return
		}
	}

	// Copy safe response headers.
	// Deliberately skip X-Frame-Options, Content-Security-Policy, and
	// Cross-Origin-* headers so the page can be embedded in our iframe.
	for _, h := range []string{
		"Content-Type", "Cache-Control", "ETag", "Last-Modified",
		"Expires", "Vary",
	} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}

	ct := resp.Header.Get("Content-Type")

	// ── HTML: make kubernetes.io URLs relative + inject helpers ──
	if strings.Contains(ct, "text/html") {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "read: " + err.Error()})
			return
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(resp.StatusCode)
		w.Write([]byte(rewriteHTML(string(body))))
		return
	}

	// ── CSS: make kubernetes.io url() refs relative ──
	if strings.Contains(ct, "text/css") {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "read: " + err.Error()})
			return
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(resp.StatusCode)
		w.Write([]byte(rewriteCSS(string(body))))
		return
	}

	// ── JavaScript: rewrite kubernetes.io URLs so dynamic navigation stays in proxy ──
	if strings.Contains(ct, "javascript") || strings.Contains(ct, "ecmascript") ||
		(strings.Contains(ct, "text/") && strings.HasSuffix(path, ".js")) {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "read: " + err.Error()})
			return
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(resp.StatusCode)
		w.Write([]byte(rewriteJS(string(body))))
		return
	}

	// ── Everything else (images, fonts, Pagefind chunks): pass through ──
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// ---------------------------------------------------------------------------
// Minimal URL rewriting — only for absolute kubernetes.io URLs
// ---------------------------------------------------------------------------

func rewriteHTML(html string) string {
	// ── Step 1: Convert absolute kubernetes.io URLs to relative ──
	// This is the only URL rewriting needed — everything else is already
	// relative and works because our path structure mirrors kubernetes.io.
	html = strings.ReplaceAll(html, "https://kubernetes.io/", "/")
	html = strings.ReplaceAll(html, "http://kubernetes.io/", "/")
	html = strings.ReplaceAll(html, "//kubernetes.io/", "/")
	// Bare domain in quotes (e.g. in JSON-LD, Open Graph)
	html = strings.ReplaceAll(html, `"https://kubernetes.io"`, `"/"`)
	html = strings.ReplaceAll(html, `'https://kubernetes.io'`, `'/'`)

	// ── Step 2: <head> injections ──
	// - Force light color scheme (no auto dark-mode in iframe)
	// - Force Pagefind search (set can_google=false cookie so main.js
	//   skips Google CSE, which requires ATS-compatible HTTPS)
	if idx := strings.Index(html, "<head"); idx >= 0 {
		closeIdx := strings.Index(html[idx:], ">")
		if closeIdx >= 0 {
			insert := idx + closeIdx + 1
			html = html[:insert] +
				`<meta name="color-scheme" content="light">` +
				`<script>document.cookie="can_google=false;path=/";</script>` +
				html[insert:]
		}
	}

	// ── Step 3: Click interceptor for external links ──
	// Relative and root-relative links stay within the proxy naturally.
	// We only need to block/handle absolute links to other domains.
	interceptor := `<script>
(function(){
  function k8sPath(href){
    if(!href)return null;
    // Handle Google tracking redirect URLs
    var gm=href.match(/https?:\/\/(?:www\.)?google\.com\/url\?[^"]*?[?&](?:q|url)=([^&]+)/);
    if(gm)href=decodeURIComponent(gm[1]);
    var m=href.match(/^https?:\/\/kubernetes\.io(\/.*)/);
    return m?m[1]:null;
  }
  // Click interceptor: rewrite kubernetes.io links, block external
  document.addEventListener("click",function(e){
    var a=e.target.closest("a");
    if(!a)return;
    var h=a.getAttribute("href")||a.href;
    if(!h||h.charAt(0)==="#"||h.startsWith("javascript:"))return;
    if(!h.match(/^https?:\/\//))return;
    var path=k8sPath(h);
    if(path){e.preventDefault();window.location.href=path;return;}
    // Block other external links
    e.preventDefault();
  },true);
  // MutationObserver: rewrite kubernetes.io hrefs on dynamically added links
  new MutationObserver(function(mutations){
    mutations.forEach(function(m){
      m.addedNodes.forEach(function(n){
        if(n.nodeType!==1)return;
        var links=n.tagName==="A"?[n]:n.querySelectorAll?n.querySelectorAll("a"):[];
        for(var i=0;i<links.length;i++){
          var raw=links[i].getAttribute("href");
          var path=k8sPath(raw);
          if(path)links[i].setAttribute("href",path);
        }
      });
    });
  }).observe(document.body,{childList:true,subtree:true});
  // Form interceptor: block external form submissions
  document.addEventListener("submit",function(e){
    var f=e.target;
    if(!f||f.tagName!=="FORM")return;
    var action=f.getAttribute("action")||"";
    if(action.match(/^https?:\/\//)){e.preventDefault();return;}
  },true);
  // Navigation via postMessage from parent (cross-origin iframe support)
  window.addEventListener("message",function(e){
    var d=e.data;
    if(d==="nav:back") history.back();
    else if(d==="nav:forward") history.forward();
    else if(d==="nav:reload") location.reload();
  });
  // Notify parent of URL changes so the address bar updates
  function notifyParent(){
    try{parent.postMessage({type:"nav:url",url:location.href},"*");}catch(e){}
  }
  window.addEventListener("popstate",notifyParent);
  // Also notify on initial load
  notifyParent();
})();
</script>`

	if idx := strings.LastIndex(html, "</body>"); idx >= 0 {
		html = html[:idx] + interceptor + html[idx:]
	} else {
		html += interceptor
	}

	return html
}

func rewriteCSS(css string) string {
	// Only convert absolute kubernetes.io URLs — relative url() refs
	// already point to the right paths since we mirror the structure.
	css = strings.ReplaceAll(css, "https://kubernetes.io/", "/")
	css = strings.ReplaceAll(css, "http://kubernetes.io/", "/")
	return css
}

func rewriteJS(js string) string {
	// Rewrite absolute kubernetes.io URLs in JavaScript so that dynamic
	// navigation (window.location.href = ...) stays within the proxy.
	js = strings.ReplaceAll(js, "https://kubernetes.io/", "/")
	js = strings.ReplaceAll(js, "http://kubernetes.io/", "/")
	js = strings.ReplaceAll(js, "//kubernetes.io/", "/")
	// Bare domain in string literals
	js = strings.ReplaceAll(js, `"https://kubernetes.io"`, `""`)
	js = strings.ReplaceAll(js, `'https://kubernetes.io'`, `''`)
	js = strings.ReplaceAll(js, `"http://kubernetes.io"`, `""`)
	js = strings.ReplaceAll(js, `'http://kubernetes.io'`, `''`)
	return js
}

func rewriteLocation(loc string) string {
	// Convert redirect targets from absolute kubernetes.io URLs to relative.
	for _, scheme := range []string{"https://", "http://"} {
		if strings.HasPrefix(loc, scheme+"kubernetes.io") {
			return strings.TrimPrefix(loc, scheme+"kubernetes.io")
		}
	}
	// Root-relative redirects are fine as-is
	return loc
}

// serveSearchPage returns a search page that tries Google CSE first
// (same engine as kubernetes.io) with Pagefind as fallback.
// This gives the same search results as the real CKA exam.
func serveSearchPage(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")

	page := fmt.Sprintf(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Search Results | Kubernetes</title>
<link rel="stylesheet" href="/pagefind/pagefind-ui.css">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; background: #fff; color: #333;
  }
  .search-header {
    background: #326ce5; color: white; padding: 20px 24px;
  }
  .search-header h1 { margin: 0; font-size: 1.3rem; font-weight: 500; }
  .search-container {
    max-width: 800px; margin: 20px auto; padding: 0 20px;
  }
  .back-link {
    display: inline-block; margin-bottom: 12px;
    color: #326ce5; text-decoration: none; font-size: 14px;
  }
  .back-link:hover { text-decoration: underline; }
  .search-input {
    width: 100%%; padding: 10px 14px; font-size: 15px;
    border: 2px solid #326ce5; border-radius: 6px;
    outline: none; margin-bottom: 16px;
  }
  .search-input:focus { border-color: #1d4ed8; box-shadow: 0 0 0 3px rgba(50,108,229,0.15); }
  #gcse-results { min-height: 200px; }
  #pagefind-results { display: none; }
  .pagefind-ui__result-link { color: #326ce5 !important; }
  .fallback-note {
    color: #666; font-size: 13px; margin-bottom: 12px; font-style: italic;
  }
  /* Make Google CSE results look cleaner */
  .gsc-control-cse { padding: 0 !important; border: none !important; }
  .gsc-above-wrapper-area { display: none; }
</style>
</head>
<body>
<div class="search-header">
  <h1>Search Kubernetes Documentation</h1>
</div>
<div class="search-container">
  <a class="back-link" href="/docs/">&#8592; Back to Documentation</a>
  <input type="text" class="search-input" id="searchInput" placeholder="Search kubernetes.io docs..." autofocus>
  <div id="gcse-results"></div>
  <div id="pagefind-results"></div>
</div>

<!-- Set query FIRST so it's available to all scripts -->
<script>
var QUERY = %q;
if (QUERY) document.getElementById('searchInput').value = QUERY;
</script>

<!-- Try Google CSE first (same engine as real CKA exam) -->
<script>
var gcseLoaded = false;
var gcseTimeout = setTimeout(function() {
  if (!gcseLoaded) loadPagefind();
}, 5000);

window.__gcse = {
  parsetags: 'explicit',
  callback: function() {
    gcseLoaded = true;
    clearTimeout(gcseTimeout);
    if (QUERY) {
      google.search.cse.element.render({div:'gcse-results', tag:'searchresults-only'});
      var el = google.search.cse.element.getElement('gcse-results');
      if (el) el.execute(QUERY);
    }
  }
};
</script>
<script async src="https://cse.google.com/cse.js?cx=013288817511911618469:elfqqbqldzg"></script>

<!-- Pagefind fallback if Google CSE fails -->
<script src="/pagefind/pagefind-ui.js"></script>
<script>
var pagefindInstance = null;

function loadPagefind() {
  document.getElementById('gcse-results').style.display = 'none';
  document.getElementById('pagefind-results').style.display = 'block';
  var note = document.createElement('div');
  note.className = 'fallback-note';
  note.textContent = 'Showing offline docs search (Google unavailable)';
  document.getElementById('pagefind-results').prepend(note);

  var pfDiv = document.createElement('div');
  pfDiv.id = 'pf-search';
  document.getElementById('pagefind-results').appendChild(pfDiv);

  pagefindInstance = new PagefindUI({
    element: '#pf-search',
    showImages: false,
    bundlePath: '/pagefind/',
    showSubResults: true,
    excerptLength: 30,
    pageSize: 10
  });
  var q = document.getElementById('searchInput').value;
  if (q) pagefindInstance.triggerSearch(q);
}

function doSearch(q) {
  if (!q) return;
  QUERY = q;
  document.getElementById('searchInput').value = q;

  // Update URL
  var url = new URL(window.location);
  url.searchParams.set('q', q);
  history.replaceState(null, '', url);
  try{parent.postMessage({type:"nav:url",url:location.href},"*");}catch(ex){}

  if (gcseLoaded) {
    var el = google.search.cse.element.getElement('gcse-results');
    if (el) el.execute(q);
  } else if (pagefindInstance) {
    pagefindInstance.triggerSearch(q);
  }
}

// Handle search input
document.getElementById('searchInput').addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  doSearch(this.value.trim());
});

// Intercept result clicks — handle Google tracking redirects + kubernetes.io URLs
document.addEventListener("click", function(e) {
  var a = e.target.closest("a");
  if (!a) return;
  var href = a.getAttribute("href") || a.href;
  if (!href) return;
  // Google CSE wraps results in tracking redirects — extract the real URL
  var gm = href.match(/https?:\/\/(?:www\.)?google\.com\/url\?[^"]*?[?&](?:q|url)=([^&]+)/);
  if (gm) href = decodeURIComponent(gm[1]);
  // Rewrite kubernetes.io links to relative
  var m = href.match(/^https?:\/\/kubernetes\.io(\/.*)/);
  if (m) {
    e.preventDefault();
    window.location.href = m[1];
    return;
  }
  // Relative URLs — let them navigate naturally
  if (!href.match(/^https?:\/\//)) return;
  // Block other external links
  e.preventDefault();
}, true);

// Navigation via postMessage
window.addEventListener("message",function(e){
  if(e.data==="nav:back") history.back();
  else if(e.data==="nav:forward") history.forward();
  else if(e.data==="nav:reload") location.reload();
});
try{parent.postMessage({type:"nav:url",url:location.href},"*");}catch(ex){}
</script>
</body>
</html>`, query)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(page))
}
