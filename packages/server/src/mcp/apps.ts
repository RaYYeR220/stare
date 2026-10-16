import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * MCP Apps (ui://) rendered inside the host. The ext-apps browser bundle is inlined so the app needs no
 * network access; its exported App class is bound to a stable name at build time.
 */
let bundle: string | null = null;
function appBundle(): string {
  if (bundle) return bundle;
  const require = createRequire(import.meta.url);
  const pkg = dirname(require.resolve('@modelcontextprotocol/ext-apps/package.json'));
  let src = readFileSync(join(pkg, 'dist/src/app-with-deps.js'), 'utf8');
  const m = src.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!m) throw new Error('unexpected ext-apps bundle shape');
  const alias = m[1]!
    .split(',')
    .map((s) => s.trim())
    .find((s) => /\sas\s+App$/.test(s))
    ?.split(/\s+as\s+/)[0];
  if (!alias) throw new Error('App export not found in ext-apps bundle');
  src = `${src.slice(0, m.index)}\nconst McpApp = ${alias};`;
  bundle = src;
  return src;
}

const STYLE = `
:root{--ground:#2a0f12;--raised:#3e1519;--ink:#ece3d2;--muted:#c4b59b;--rule:rgba(236,227,210,.14);--gold:#c6a04c;--red:#e2583c;--yellow:#e8c14c;--green:#67b383;--blue:#7ea3df}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:18px}
h1{font:300 22px/1.2 "Newsreader",Georgia,"Times New Roman",serif;letter-spacing:-.02em;margin:0 0 6px}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.card{background:var(--raised);border-top:1px solid var(--gold);padding:12px 14px;margin:12px 0}
.card>b{font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}
.flag{display:inline-flex;align-items:center;gap:6px;font-weight:600;white-space:nowrap}.g{color:var(--green)}.y{color:var(--yellow)}.r{color:var(--red)}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--rule)}.card>.row:first-of-type{border-top:0}
.check{display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--rule)}
`;

const GLYPH = `function glyph(f){return f==='green'?'<span class="flag g">◆ good law</span>':f==='yellow'?'<span class="flag y">▲ overruling risk</span>':'<span class="flag r">⬣ not good law</span>'}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}`;

const TRACE = `
const root=document.getElementById('root');
function render(d){
  if(!d){root.innerHTML='<p class="muted">Waiting for a decision…</p>';return}
  if(d.decision){ // explain_decision
    const x=d.decision;
    root.innerHTML='<h1>'+esc(x.account)+' — '+esc(x.outcome)+' '+esc(x.value)+'</h1><p class="muted">'+esc(x.narrative)+'</p>'+
      '<div class="card"><div class="row"><span>Standing</span>'+glyph(x.standing.flag)+'</div><div class="row"><span>Decided by</span><span>'+esc(x.madeBy)+(x.onAuthorityOf?' on '+esc(x.onAuthorityOf)+'’s delegation':'')+'</span></div><div class="row"><span>Policy</span><span class="mono">'+esc(x.policyVersion)+'</span></div><div class="row"><span>Ledger</span><span class="mono">#'+esc(x.ledgerSeq)+' '+esc(String(x.ledgerHash||'').slice(0,16))+'…</span></div></div>'+
      '<div class="card"><b>Precedent chain</b>'+(d.chain.length?d.chain.map(c=>'<div class="row"><span>'+esc(c.account)+' <span class="muted">'+new Date(c.at).toISOString().slice(0,10)+' · '+esc(c.madeBy)+'</span></span>'+glyph(c.standing.flag)+'</div>').join(''):'<p class="muted">No citations.</p>')+'</div>';
    return;
  }
  const head={approved:'Approved',counter:'Counter-offer',escalated:'Escalated',denied:'Denied',not_in_graph:'Not in the graph',needs_info:'Needs information'}[d.outcome]||d.outcome;
  root.innerHTML='<h1>'+head+(d.account?' — '+esc(d.account):'')+'</h1><p class="muted">'+esc(d.explanation)+'</p>'+
    (d.citations&&d.citations.length?'<div class="card"><b>Relied on</b>'+d.citations.map(c=>'<div class="row"><span>'+esc(c.account)+' <span class="muted">'+esc(c.at)+' · '+esc(c.madeBy)+'</span></span>'+glyph(c.flag)+'</div>').join('')+'</div>':'')+
    (d.notReliedOn&&d.notReliedOn.length?'<div class="card"><b>Looked similar, not relied on</b>'+d.notReliedOn.map(c=>'<div class="row"><span>'+esc(c.account)+' <span class="muted">'+esc(c.reasons.join(', '))+'</span></span>'+glyph(c.flag)+'</div>').join('')+'</div>':'')+
    (d.route?'<div class="card"><b>Authority path</b><p class="mono">'+esc(d.route.pathNames.join(' → '))+'</p></div>':'')+
    '<div class="card"><b>Cypher that ran</b>'+(d.cypher||[]).map(t=>'<div class="row mono"><span>'+esc(t.name)+'</span><span>'+esc(t.ms)+' ms · '+esc(t.rows)+' rows</span></div>').join('')+'</div>';
}`;

const CERT = `
const root=document.getElementById('root');
function render(d){
  if(!d||!d.checks){root.innerHTML='<p class="muted">Waiting for a certificate…</p>';return}
  root.innerHTML='<h1>Certificate of erasure — '+esc(d.verdict)+'</h1><p class="muted mono">'+esc(d.erasureId)+' · '+new Date(d.at).toISOString()+'</p>'+
    '<div class="card">'+d.checks.map(c=>'<div class="check"><span class="flag '+(c.pass?'g':'r')+'">'+(c.pass?'✓':'✗')+' '+esc(c.id)+'</span><span><b>'+esc(c.name)+'</b><br><span class="muted">'+esc(c.detail)+'</span></span></div>').join('')+'</div>'+
    '<div class="card"><div class="row"><span>Messages erased</span><span>'+d.counts.messagesErased+'</span></div><div class="row"><span>Facts deleted / kept</span><span>'+d.counts.factsDeleted.length+' / '+d.counts.factsRetained.length+'</span></div><div class="row"><span>Records redacted</span><span>'+d.counts.recordsRedacted+'</span></div><div class="row"><span>Ledger</span><span>'+(d.ledger.ok?'verifies':'BROKEN')+', '+d.ledger.length+' entries</span></div></div>'+
    '<p class="mono muted">subject commitment '+esc(d.subjectCommitment)+'<br>certificate '+esc(d.certificateHash)+'</p>';
}`;

export function appHtml(kind: 'trace' | 'certificate'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stare</title><style>${STYLE}</style></head>
<body><div id="root"><p class="muted">Loading…</p></div>
<script type="module">
${appBundle()}
${GLYPH}
${kind === 'trace' ? TRACE : CERT}
const app = new McpApp({ name: 'stare-${kind}', version: '1.0.0' });
render(null);
app.ontoolresult = (r) => render(r.structuredContent);
await app.connect();
</script></body></html>`;
}
