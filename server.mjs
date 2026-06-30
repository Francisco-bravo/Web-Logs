import http from 'node:http'
import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const PORT = Number(process.env.PORT || 8090)
const TOKEN = process.env.LOGS_TOKEN || 'changeme'

// Fuentes remotas via SSH (para leer desde Oracle VM donde corre el bot)
const ORACLE_HOST = process.env.ORACLE_HOST || '146.181.44.27'
const ORACLE_USER = process.env.ORACLE_USER || 'ubuntu'
// La clave SSH en base64: base64(contenido del archivo .pem)
const ORACLE_SSH_KEY_B64 = process.env.ORACLE_SSH_KEY_B64 || ''

// Escribe la clave SSH en /tmp y devuelve la ruta. Limpiar después de usar.
function writeSshKey() {
  if (!ORACLE_SSH_KEY_B64) return null
  const path = join(tmpdir(), `weblogs_key_${process.pid}`)
  try {
    writeFileSync(path, Buffer.from(ORACLE_SSH_KEY_B64, 'base64').toString('utf8'), { mode: 0o600 })
    return path
  } catch { return null }
}

const SERVICES = {
  // Logs del bot de Discord (Oracle VM)
  'music-bot': {
    label: 'Bot de Discord',
    remote: true,
    cmd: 'journalctl -u music-bot -f -n 300 --no-pager --output=short-iso',
  },
  // Logs de la web (Oracle VM)
  'music-web': {
    label: 'Web (music-web)',
    remote: true,
    cmd: 'journalctl -u music-web -f -n 300 --no-pager --output=short-iso',
  },
  // Bot + Web juntos (Oracle VM)
  'all': {
    label: 'Bot + Web',
    remote: true,
    cmd: 'journalctl -u music-bot -u music-web -f -n 500 --no-pager --output=short-iso',
  },
  // Logs del worker de música (contenedor Docker en CX33, via socket)
  'worker': {
    label: 'Worker CX33',
    remote: false,
    // shell: busca el contenedor por label de Coolify y sigue sus logs
    cmd: ['sh', '-c',
      "docker logs -f --tail 200 $(docker ps -q --filter 'label=coolify.applicationId=v132p5q9aszr0dsmda22w4zn') 2>&1 || echo '[No se encontró el contenedor del worker]'"],
  },
}

const SERVICES_LABELS = Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, v.label]))

const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Logs — Asher</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { background: #0d1117; color: #c9d1d9; font-family: 'Courier New', monospace; font-size: 13px; height: 100vh; display: flex; flex-direction: column }
  #header { background: #161b22; border-bottom: 1px solid #30363d; padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex-shrink: 0; flex-wrap: wrap }
  #header h1 { font-size: 15px; color: #58a6ff; font-family: sans-serif; white-space: nowrap }
  #tabs { display: flex; gap: 4px; flex-wrap: wrap }
  .tab { padding: 4px 12px; border-radius: 4px; cursor: pointer; border: 1px solid #30363d; background: transparent; color: #8b949e; font-size: 12px; font-family: sans-serif }
  .tab.active { background: #21262d; color: #c9d1d9; border-color: #58a6ff }
  .tab:hover:not(.active) { background: #21262d }
  #controls { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap }
  #filter { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 8px; border-radius: 4px; font-size: 12px; width: 180px }
  #filter:focus { outline: none; border-color: #58a6ff }
  .btn { padding: 4px 10px; border-radius: 4px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; cursor: pointer; font-size: 12px; font-family: sans-serif }
  .btn:hover { background: #30363d }
  #status { font-size: 11px; font-family: sans-serif; white-space: nowrap }
  #status.ok { color: #3fb950 }
  #status.err { color: #f85149 }
  #log { flex: 1; overflow-y: auto; padding: 10px 16px; line-height: 1.55 }
  .line { white-space: pre-wrap; word-break: break-all }
  .line.err  { color: #f85149 }
  .line.warn { color: #d29922 }
  .line.info { color: #79c0ff }
  .line.dim  { color: #6e7681 }
  #login { display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; gap: 12px }
  #login input { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 12px; border-radius: 6px; font-size: 14px; width: 220px; font-family: sans-serif }
  #login input:focus { outline: none; border-color: #58a6ff }
  #login button { padding: 8px 24px; background: #238636; border: 1px solid #2ea043; color: #fff; border-radius: 6px; cursor: pointer; font-size: 14px; font-family: sans-serif }
  #login button:hover { background: #2ea043 }
  #login p { color: #8b949e; font-family: sans-serif; font-size: 13px }
  .hidden { display: none !important }
  #autoscroll { accent-color: #58a6ff }
</style>
</head>
<body>
<div id="login">
  <p>🔒 Logs del sistema — Asher</p>
  <input id="pwd" type="password" placeholder="Contraseña" autocomplete="current-password">
  <button onclick="doLogin()">Entrar</button>
  <p id="loginErr" style="color:#f85149;display:none">Contraseña incorrecta</p>
</div>
<div id="app" class="hidden">
  <div id="header">
    <h1>📋 Logs</h1>
    <div id="tabs"></div>
    <div id="controls">
      <input id="filter" type="text" placeholder="Filtrar..." oninput="applyFilter()">
      <label style="font-family:sans-serif;font-size:12px;color:#8b949e;display:flex;align-items:center;gap:4px">
        <input type="checkbox" id="autoscroll" checked> Auto-scroll
      </label>
      <button class="btn" onclick="clearLog()">Limpiar</button>
      <span id="status" class="ok">●</span>
    </div>
  </div>
  <div id="log"></div>
</div>
<script>
const SERVICES = ${JSON.stringify(SERVICES_LABELS)};
let token = '';
let currentSvc = 'all';
let es = null;
let lines = [];
const MAX_LINES = 2000;

function doLogin() {
  const pwd = document.getElementById('pwd').value;
  fetch('/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: pwd }) })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        token = pwd;
        document.getElementById('login').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        buildTabs();
        connect('all');
      } else {
        document.getElementById('loginErr').style.display = '';
      }
    });
}
document.getElementById('pwd').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() });

function buildTabs() {
  const el = document.getElementById('tabs');
  el.innerHTML = '';
  for (const [k, label] of Object.entries(SERVICES)) {
    const b = document.createElement('button');
    b.className = 'tab' + (k === currentSvc ? ' active' : '');
    b.textContent = label;
    b.onclick = () => connect(k);
    b.dataset.svc = k;
    el.appendChild(b);
  }
}

function connect(svc) {
  if (es) { es.close(); es = null; }
  currentSvc = svc;
  lines = [];
  document.getElementById('log').innerHTML = '';
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.svc === svc));
  setStatus('ok', '● Conectando…');
  es = new EventSource('/stream?service=' + svc + '&token=' + encodeURIComponent(token));
  es.onopen = () => setStatus('ok', '● Conectado');
  es.onmessage = e => addLine(e.data);
  es.onerror = () => setStatus('err', '● Desconectado — reintentando…');
}

function setStatus(cls, txt) {
  const el = document.getElementById('status');
  el.className = cls; el.textContent = txt;
}

const filterText = () => document.getElementById('filter').value.toLowerCase();

function classify(txt) {
  if (/error|err |exception|fatal|critical/i.test(txt)) return 'err';
  if (/warn|warning|deprecat/i.test(txt)) return 'warn';
  if (/\\binfo\\b|started|ready|listening/i.test(txt)) return 'info';
  if (/^[A-Z][a-z]{2} [0-9]/.test(txt)) return 'dim';
  return '';
}

function addLine(raw) {
  lines.push(raw);
  if (lines.length > MAX_LINES) lines.shift();
  const ft = filterText();
  if (ft && !raw.toLowerCase().includes(ft)) return;
  appendDOM(raw);
}

function appendDOM(raw) {
  const el = document.getElementById('log');
  const d = document.createElement('div');
  d.className = 'line ' + classify(raw);
  d.textContent = raw;
  el.appendChild(d);
  if (el.children.length > MAX_LINES * 2) {
    while (el.children.length > MAX_LINES) el.removeChild(el.firstChild);
  }
  if (document.getElementById('autoscroll').checked) el.scrollTop = el.scrollHeight;
}

function applyFilter() {
  const ft = filterText();
  document.getElementById('log').innerHTML = '';
  for (const line of lines) {
    if (!ft || line.toLowerCase().includes(ft)) appendDOM(line);
  }
}

function clearLog() {
  lines = [];
  document.getElementById('log').innerHTML = '';
}
</script>
</body>
</html>`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.method === 'POST' && path === '/auth') {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
      try {
        const { token } = JSON.parse(body)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: token === TOKEN }))
      } catch { res.writeHead(400).end('{}') }
    })
    return
  }

  if (path === '/stream') {
    const tok = url.searchParams.get('token')
    if (tok !== TOKEN) { res.writeHead(401).end('Unauthorized'); return }
    const svcId = url.searchParams.get('service') || 'all'
    const cfg = SERVICES[svcId]
    if (!cfg) { res.writeHead(400).end('Unknown service'); return }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`data: [Conectando a ${cfg.label}...]\n\n`)

    if (cfg.remote && !ORACLE_SSH_KEY_B64) {
      res.write('data: [Error: ORACLE_SSH_KEY_B64 no configurado en Coolify]\n\n')
      res.end()
      return
    }

    const keyPath = cfg.remote ? writeSshKey() : null
    if (cfg.remote && !keyPath) {
      res.write('data: [Error: No se pudo escribir la clave SSH]\n\n')
      res.end()
      return
    }

    const proc = cfg.remote
      ? spawn('ssh', [
          '-i', keyPath,
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ServerAliveInterval=30',
          '-o', 'ConnectTimeout=15',
          `${ORACLE_USER}@${ORACLE_HOST}`,
          cfg.cmd,
        ])
      : spawn(cfg.cmd[0], cfg.cmd.slice(1))

    let buf = ''
    const flush = data => {
      buf += data
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line) res.write('data: ' + line + '\n\n')
      }
    }
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', flush)
    proc.stderr.on('data', d => res.write(`data: [stderr] ${d.trim()}\n\n`))
    proc.on('close', code => {
      if (keyPath) { try { unlinkSync(keyPath) } catch {} }
      res.write(`data: [Proceso terminado (código ${code})]\n\n`)
      try { res.end() } catch {}
    })
    proc.on('error', err => {
      if (keyPath) { try { unlinkSync(keyPath) } catch {} }
      res.write(`data: [Error al iniciar: ${err.message}]\n\n`)
      try { res.end() } catch {}
    })
    req.on('close', () => { try { proc.kill() } catch {} })
    return
  }

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(HTML)
    return
  }

  // Health check para Coolify
  if (path === '/health') {
    res.writeHead(200).end('ok')
    return
  }

  res.writeHead(404).end('Not found')
})

server.listen(PORT, () => {
  console.log(`WebLogs escuchando en http://0.0.0.0:${PORT}`)
  console.log(`Oracle: ${ORACLE_USER}@${ORACLE_HOST} ${ORACLE_SSH_KEY_B64 ? '(clave SSH configurada)' : '(sin clave SSH — solo logs locales)'}`)
  if (TOKEN === 'changeme') console.warn('⚠️  Cambia LOGS_TOKEN antes de usar en producción')
})
