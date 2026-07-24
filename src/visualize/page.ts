/**
 * The branded single-page visualizer app (LangChain design system). Served as-is
 * at "/". All wiki-sourced content is escaped client-side before innerHTML; the
 * browser libraries load from cdn.jsdelivr.net at pinned exact versions with SRI
 * hashes, so a tampered CDN response is rejected by the browser.
 */
export const PAGE = /* html */ `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenWiki visualizer</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<script
  src="https://cdn.jsdelivr.net/npm/force-graph@1.49.5/dist/force-graph.min.js"
  integrity="sha384-Q7cpDGRIjLb0dIzHOl/cCcP5MM6ixkekYU/M/Y4shUqh7h2IgtwAY7coox/PB0/S"
  crossorigin="anonymous"
></script>
<script
  src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"
  integrity="sha384-/TQbtLCAerC3jgaim+N78RZSDYV7ryeoBCVqTuzRrFec2akfBkHS7ACQ3PQhvMVi"
  crossorigin="anonymous"
></script>
<script
  src="https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js"
  integrity="sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E"
  crossorigin="anonymous"
></script>
<style>
:root {
  --lc-dark:#030710; --lc-card:#0B1120; --lc-surface:#F2FAFF;
  --lc-border-dark:#1A2740; --lc-border:#B8DFFF; --lc-muted:#6B8299;
  --lc-body:#C8DDF0; --lc-white:#FFFFFF; --lc-dark-text:#030710;
  --lc-blue:#7FC8FF; --lc-blue-hover:#99D4FF; --lc-blue-bg:#E5F4FF;
  --lc-lime:#E3FF8F; --lc-rose:#B27D75; --lc-pink:#C78EAD; --lc-lavender:#D5C3F7;
  /* semantic (dark default) */
  --bg:var(--lc-dark); --panel:var(--lc-card); --edge:var(--lc-border-dark);
  --text:var(--lc-body); --heading:var(--lc-white); --muted:var(--lc-muted);
  --tag-bg:rgba(127,200,255,0.12); --tag-text:var(--lc-blue);
  --graph-bg:#050a16; --node-label:#8CA3BD; --code-bg:#0a1424;
}
[data-theme="light"] {
  --bg:var(--lc-surface); --panel:#FFFFFF; --edge:var(--lc-border);
  --text:#3D5166; --heading:var(--lc-dark-text); --muted:#5B7086;
  --tag-bg:var(--lc-blue-bg); --tag-text:#1A6FB5;
  --graph-bg:#EAF5FF; --node-label:#3D5166; --code-bg:#EEF6FF;
}
* , *::before, *::after { box-sizing:border-box; }
html, body { height:100%; margin:0; }
body {
  font-family:"Lausanne","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:var(--bg); color:var(--text);
  display:flex; flex-direction:column; overflow:hidden;
  transition:background .3s ease, color .3s ease;
}
a { color:var(--lc-blue); text-decoration:none; }
a:hover { color:var(--lc-blue-hover); text-decoration:underline; }

/* Topbar */
.topbar {
  display:flex; align-items:center; gap:20px;
  padding:14px 22px; border-bottom:1px solid var(--edge);
  background:linear-gradient(180deg, color-mix(in srgb, var(--panel) 85%, transparent), transparent);
  backdrop-filter:blur(8px); flex:0 0 auto; z-index:10;
}
.brand { display:flex; align-items:center; gap:12px; color:var(--heading); }
.brand .lc-logo-full { height:20px; width:auto; }
.brand .divider { width:1px; height:22px; background:var(--edge); }
.brand .title { font-weight:700; font-size:15px; letter-spacing:-0.01em; color:var(--heading); }
.brand .title small { display:block; font-weight:500; font-size:11px; color:var(--muted); letter-spacing:0.02em; }
.spacer { flex:1; }
.control { display:flex; align-items:center; gap:8px; }
input.search, select.filter {
  font:inherit; font-size:13px; color:var(--text); background:var(--bg);
  border:1px solid var(--edge); border-radius:8px; padding:8px 12px; outline:none;
  transition:border-color .15s ease;
}
input.search { width:220px; }
input.search:focus, select.filter:focus { border-color:var(--lc-blue); }
input.search::placeholder { color:var(--muted); }
.icon-btn {
  display:inline-flex; align-items:center; justify-content:center;
  width:36px; height:36px; border-radius:8px; cursor:pointer;
  border:1px solid var(--edge); background:var(--bg); color:var(--text);
  transition:border-color .15s ease, color .15s ease;
}
.icon-btn:hover { border-color:var(--lc-blue); color:var(--lc-blue); }
.live-pill {
  display:inline-flex; align-items:center; gap:7px;
  font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase;
  color:var(--lc-dark-text); background:var(--lc-lime);
  padding:5px 11px; border-radius:100px;
}
.live-pill.stale { background:var(--lc-rose); color:var(--lc-white); }
.live-dot { width:7px; height:7px; border-radius:50%; background:currentColor; animation:pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }

/* Main split */
.main { flex:1; display:flex; min-height:0; }
/* Left index: the whole wiki as a browsable, always-visible list. */
.sidebar {
  width:236px; flex:0 0 auto; border-right:1px solid var(--edge);
  background:var(--panel); overflow-y:auto; padding:20px 14px;
}
.sidebar::-webkit-scrollbar { width:10px; }
.sidebar::-webkit-scrollbar-thumb { background:var(--edge); border-radius:8px; }
.sb-head { display:flex; align-items:baseline; justify-content:space-between; padding:2px 8px 6px; }
.sb-head .sb-title { font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:var(--muted); }
.sb-head .sb-count { font-size:11px; color:var(--muted); }
.sb-group { margin-top:12px; }
.sb-group.hidden { display:none; }
.sb-group-head { display:flex; align-items:center; gap:7px; padding:4px 8px; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted); }
.sb-group-head .swatch { width:9px; height:9px; border-radius:3px; flex:0 0 auto; }
.nav-item { display:flex; align-items:center; gap:8px; width:100%; text-align:left; font:inherit; font-size:13px; color:var(--text); background:none; border:none; border-radius:7px; padding:6px 9px; cursor:pointer; line-height:1.3; }
.nav-item:hover { background:color-mix(in srgb, var(--lc-blue) 12%, transparent); }
.nav-item.active { background:color-mix(in srgb, var(--lc-blue) 20%, transparent); color:var(--heading); font-weight:600; }
.nav-item.hidden { display:none; }
.nav-item .dot { width:7px; height:7px; border-radius:50%; flex:0 0 auto; }
.nav-item .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#graph { flex:1; min-width:0; position:relative; overflow:hidden; background:radial-gradient(120% 120% at 30% 10%, color-mix(in srgb, var(--graph-bg) 92%, var(--lc-blue) 8%), var(--graph-bg)); }
.detail {
  flex:1 1 0; min-width:0; border-left:1px solid var(--edge);
  background:var(--panel); overflow-y:auto; padding:40px 48px;
  position:relative; z-index:2;
}
.detail::-webkit-scrollbar { width:10px; }
.detail::-webkit-scrollbar-thumb { background:var(--edge); border-radius:8px; }

/* Legend */
.legend {
  position:absolute; left:20px; bottom:18px; z-index:5;
  display:flex; flex-wrap:wrap; gap:6px 14px; max-width:60%;
  padding:12px 14px; border-radius:12px;
  background:color-mix(in srgb, var(--panel) 88%, transparent);
  border:1px solid var(--edge); backdrop-filter:blur(6px);
}
.legend .item { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--muted); }
.legend .swatch { width:11px; height:11px; border-radius:3px; }

/* Detail content */
.eyebrow { font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:var(--lc-blue); }
.detail h1.doc-title { font-size:30px; font-weight:800; line-height:1.15; letter-spacing:-0.03em; color:var(--heading); margin:10px 0 8px; }
.detail .desc { font-size:15px; color:var(--muted); line-height:1.6; margin:0 0 18px; }
.tags { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:22px; }
.tag {
  font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase;
  color:var(--tag-text); background:var(--tag-bg); padding:4px 11px; border-radius:100px;
}
hr.rule { border:none; border-top:1px solid var(--edge); margin:22px 0; }

/* Rendered markdown */
.md { font-size:16px; line-height:1.75; color:var(--text); }
.md h1,.md h2,.md h3,.md h4 { color:var(--heading); line-height:1.3; margin:1.6em 0 .5em; letter-spacing:-0.01em; }
.md h1 { font-size:24px; font-weight:800; } .md h2 { font-size:20px; font-weight:700; }
.md h3 { font-size:17px; font-weight:700; } .md h4 { font-size:15px; font-weight:600; }
.md p { margin:.7em 0; } .md ul,.md ol { padding-left:1.3em; margin:.7em 0; } .md li { margin:.3em 0; }
.md code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.87em; background:var(--code-bg); padding:2px 6px; border-radius:5px; color:var(--lc-blue); }
.md pre { background:var(--code-bg); border:1px solid var(--edge); border-radius:12px; padding:16px 18px; overflow-x:auto; margin:1em 0; }
.md pre code { background:none; padding:0; color:var(--text); }
.md blockquote { border-left:3px solid var(--lc-blue); margin:1em 0; padding:.2em 0 .2em 16px; color:var(--muted); }
.md table { border-collapse:collapse; width:100%; margin:1em 0; font-size:14px; }
.md th,.md td { border:1px solid var(--edge); padding:8px 12px; text-align:left; }
.md th { background:var(--tag-bg); color:var(--heading); }
.md .mermaid { display:flex; justify-content:center; margin:1.2em 0; }
.md a.wikilink { border-bottom:1px dashed color-mix(in srgb, var(--lc-blue) 55%, transparent); }

/* Backlinks */
.backlinks { margin-top:28px; }
.backlinks .eyebrow { display:block; margin-bottom:10px; }
.chip {
  display:inline-flex; align-items:center; gap:6px; cursor:pointer;
  font-size:13px; color:var(--text); background:var(--bg);
  border:1px solid var(--edge); border-radius:8px; padding:7px 12px; margin:0 8px 8px 0;
  transition:border-color .15s ease, color .15s ease;
}
.chip:hover { border-color:var(--lc-blue); color:var(--lc-blue); }
.chip::before { content:"↳"; color:var(--lc-blue); }

/* Empty state */
.empty { color:var(--muted); text-align:center; margin-top:20vh; font-size:15px; }
.empty .lc-logo-mark { height:44px; opacity:.5; margin-bottom:16px; }

/* Toast */
.toast {
  position:fixed; bottom:22px; left:50%; transform:translateX(-50%) translateY(20px);
  background:var(--lc-blue); color:var(--lc-dark-text); font-weight:600; font-size:13px;
  padding:9px 18px; border-radius:100px; box-shadow:0 8px 30px rgba(0,0,0,.35);
  opacity:0; pointer-events:none; transition:opacity .25s ease, transform .25s ease; z-index:50;
}
.toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

/* 3D graph node tooltip (rendered by 3d-force-graph on hover) */
.gtip {
  font-family:"Inter",sans-serif; font-size:12px; font-weight:600; line-height:1.2;
  color:var(--lc-dark-text); background:var(--lc-blue);
  padding:6px 11px; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.45);
  display:flex; flex-direction:column;
}
.gtip span { margin-top:3px; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:rgba(3,7,16,.62); }

/* Controls hint, stacked above the legend */
.graph-hint {
  position:absolute; left:20px; bottom:72px; z-index:5; pointer-events:none;
  font-size:11px; letter-spacing:0.02em; color:var(--muted);
  padding:6px 12px; border-radius:100px;
  background:color-mix(in srgb, var(--panel) 82%, transparent);
  border:1px solid var(--edge); backdrop-filter:blur(6px);
}
.graph-hint b { color:var(--lc-blue); font-weight:700; }
</style>
</head>
<body>
<div class="topbar">
  <div class="brand">
    <svg class="lc-logo-full" viewBox="0 0 3000 554" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M657.602 333.318V88.8672H591.197V379.431H611.489C636.967 379.431 657.602 358.796 657.602 333.318Z"/><path d="M828.858 396.176H591.197V454.876H828.858V396.176Z"/><path d="M1088.87 294.449C1088.87 229.341 1058.13 181.664 975.056 181.664C905.333 181.664 869.022 227.358 861.317 270.878H923.336C930.01 246.276 949.501 230.905 975.628 230.905C1005.84 230.905 1024.3 243.187 1024.3 264.203C1024.3 286.745 1007.9 291.894 973.568 297.005C936.647 302.612 849.531 309.782 849.531 382.595C849.531 427.182 884.393 462.044 942.292 462.044C992.525 462.044 1014.57 435.383 1025.33 414.405H1025.86V427.716C1025.86 436.413 1026.39 446.177 1027.92 454.873H1094.02C1090.4 437.938 1088.91 410.781 1088.91 390.299V294.449H1088.87ZM1025.33 331.904C1025.33 393.427 994.088 413.375 960.257 413.375C930.544 413.375 915.135 399.53 915.135 379.543C915.135 359.557 931.04 348.801 966.398 341.592C1005.34 333.926 1019.19 322.14 1025.33 309.324V331.866V331.904Z"/><path d="M1274.43 182.695C1233.43 182.695 1209.89 204.703 1194.98 235.483V189.866H1130.41V454.875H1196.51V335.949C1196.51 271.375 1220.61 240.099 1255.97 240.099C1293.92 240.099 1304.14 270.345 1304.14 308.792V454.875H1369.75V292.887C1369.75 227.817 1343.08 182.695 1274.39 182.695H1274.43Z"/><path d="M1599.44 227.244H1598.94C1589.71 205.732 1563.05 182.656 1518.96 182.656C1447.21 182.656 1395.95 232.889 1395.95 316.953C1395.95 401.018 1447.71 452.28 1519.45 452.28C1565.07 452.28 1588.64 429.738 1598.9 404.641H1599.4V436.413C1599.4 481.535 1576.32 503.047 1534.82 503.047C1499.96 503.047 1476.92 490.727 1470.78 462.044H1406.21C1413.38 514.337 1461.59 553.28 1535.89 553.28C1606.11 553.28 1668.62 517.884 1668.62 427.183V189.827H1599.47V227.244H1599.44ZM1533.79 400.522C1486.12 400.522 1462.01 361.045 1462.01 317.487C1462.01 273.929 1486.61 234.987 1533.79 234.987C1580.97 234.987 1605.54 279.574 1605.54 317.487C1605.54 355.4 1586.05 400.522 1533.79 400.522Z"/><path d="M1890.27 140.664C1939.97 140.664 1973.8 160.65 1993.29 203.712H2060.95C2038.41 128.878 1982 82.2305 1890.27 82.2305C1779.05 82.2305 1703.68 161.222 1703.68 272.405C1703.68 383.588 1778.51 461.55 1889.73 461.512C1980.47 461.512 2042.49 412.843 2060.95 340.03H1992.79C1977.92 378.973 1946.14 403.079 1890.27 403.079C1819.51 403.079 1772.37 347.735 1772.37 272.405C1772.37 197.075 1819.02 140.702 1890.27 140.702V140.664Z"/><path d="M2242.39 182.62C2201.39 182.62 2177.85 204.665 2162.94 234.912V88.8672H2098.37V454.761H2164.47V335.835C2164.47 271.261 2188.57 239.985 2223.93 239.985C2261.88 239.985 2272.1 270.231 2272.1 308.678V454.761H2337.71V292.773C2337.71 227.703 2311.05 182.581 2242.35 182.581L2242.39 182.62Z"/><path d="M2605.84 294.449C2605.84 229.341 2575.1 181.664 2492.03 181.664C2422.31 181.664 2386 227.358 2378.33 270.878H2440.35C2447.02 246.276 2466.51 230.905 2492.64 230.905C2522.85 230.905 2541.31 243.187 2541.31 264.203C2541.31 286.745 2524.91 291.894 2490.58 297.005C2453.66 302.612 2366.54 309.782 2366.54 382.595C2366.54 427.182 2401.4 462.044 2459.3 462.044C2509.54 462.044 2531.58 435.383 2542.34 414.405H2542.83V427.716C2542.83 436.413 2543.33 446.177 2544.89 454.873H2610.99C2607.41 437.938 2605.88 410.781 2605.88 390.299V294.449H2605.84ZM2542.26 331.904C2542.26 393.427 2511.02 413.375 2477.19 413.375C2447.48 413.375 2432.07 399.53 2432.07 379.543C2432.07 359.557 2447.98 348.801 2483.33 341.592C2522.28 333.926 2536.12 322.14 2542.26 309.324V331.866V331.904Z"/><path d="M2716.03 111.676H2647.88V173.198H2716.03V111.676Z"/><path d="M2648.91 235.751V454.837H2715.01V189.828H2694.79C2669.43 189.828 2648.91 210.387 2648.91 235.751Z"/><path d="M2904.65 182.695C2863.64 182.695 2840.11 204.703 2825.2 235.483V189.866H2760.62V454.875H2826.72V335.949C2826.72 271.375 2850.83 240.099 2886.19 240.099C2924.1 240.099 2934.36 270.345 2934.36 308.792V454.875H2999.96V292.887C2999.96 227.817 2973.3 182.695 2904.61 182.695H2904.65Z"/><path d="M153.197 324.988C181.918 296.266 198.063 257.269 198.063 216.654C198.063 176.039 181.904 137.042 153.197 108.32L44.866 0C16.159 28.7218 0 67.7192 0 108.334C0 148.949 16.159 187.946 44.866 216.668L153.183 324.988H153.197Z"/><path d="M379.871 335.012C351.164 306.304 312.153 290.145 271.554 290.145C230.954 290.145 191.944 306.304 163.223 335.012L271.554 443.346C300.261 472.054 339.271 488.213 379.885 488.213C420.498 488.213 459.495 472.054 488.215 443.346L379.885 335.012H379.871Z"/><path d="M45.13 443.096C73.8509 471.804 112.847 487.963 153.461 487.963V334.762H0.25C0.263942 375.377 16.409 414.374 45.13 443.096Z"/><path d="M421.695 174.84C392.974 146.132 353.978 129.959 313.35 129.973C272.737 129.973 233.74 146.132 205.02 174.854L313.35 283.188L421.695 174.84Z"/></svg>
    <div class="divider"></div>
    <div class="title">OpenWiki<small id="wiki-name">wiki visualizer</small></div>
  </div>
  <div class="spacer"></div>
  <div class="live-pill" id="live"><span class="live-dot"></span><span id="live-text">Live</span></div>
  <div class="icon-btn" id="theme" title="Toggle theme">◐</div>
</div>
<div class="main">
  <nav class="sidebar" id="sidebar"></nav>
  <div id="graph"></div>
  <div class="legend" id="legend"></div>
  <div class="graph-hint" id="hint"><b>Drag</b> to pan · <b>Scroll</b> to zoom · <b>Click</b> a node to read</div>
  <div class="detail" id="detail">
    <div class="empty">
      <svg class="lc-logo-mark" viewBox="0 0 489 489" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M153.197 324.988C181.918 296.266 198.063 257.269 198.063 216.654C198.063 176.039 181.904 137.042 153.197 108.32L44.866 0C16.159 28.7218 0 67.7192 0 108.334C0 148.949 16.159 187.946 44.866 216.668L153.183 324.988H153.197Z"/><path d="M379.871 335.012C351.164 306.304 312.153 290.145 271.554 290.145C230.954 290.145 191.944 306.304 163.223 335.012L271.554 443.346C300.261 472.054 339.271 488.213 379.885 488.213C420.498 488.213 459.495 472.054 488.215 443.346L379.885 335.012H379.871Z"/><path d="M45.13 443.096C73.8509 471.804 112.847 487.963 153.461 487.963V334.762H0.25C0.263942 375.377 16.409 414.374 45.13 443.096Z"/><path d="M421.695 174.84C392.974 146.132 353.978 129.959 313.35 129.973C272.737 129.973 233.74 146.132 205.02 174.854L313.35 283.188L421.695 174.84Z"/></svg>
      <div>Select a page to read it, or explore the graph.</div>
    </div>
  </div>
</div>
<div class="toast" id="toast">Wiki updated</div>
<script type="module" src="/client.js"></script>
</body>
</html>`;
