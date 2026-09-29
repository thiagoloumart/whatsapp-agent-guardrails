'use strict';
// whatsapp-agent-guardrails — trava central de DESTINO para envios WhatsApp via Evolution API.
// Fica entre o nginx e a Evolution API. So intercepta endpoints /message/send*.
// Regra: GRUPO default-deny (allowlist por robo OU por instancia); DM individual passa.
// Fora da allowlist: modo SOMBRA so loga; modo ENFORCE reroteia pro privado do dono + loga.
// Opcional: tudo que nao vier do robo-roteador fica RETIDO e e entregue a ele para decidir.
// Sem dependencias externas (http nativo). Recarrega allowlist.json quando o arquivo muda.

const http = require('http');
const fs = require('fs');
const path = require('path');

const CFG_PATH = path.join(__dirname, 'allowlist.json');
const LOG_PATH = path.join(__dirname, 'logs', 'guard.log');

let cfg = null, cfgMtime = 0;
function loadCfg() {
  try {
    const st = fs.statSync(CFG_PATH);
    if (st.mtimeMs !== cfgMtime) { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); cfgMtime = st.mtimeMs; }
  } catch (e) { if (!cfg) cfg = { enforce: false, owner_dm: '', upstream_host: '127.0.0.1', upstream_port: 8080, groups_by_instance: {}, groups_by_robot: {} }; }
  return cfg;
}
function log(obj) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch (e) {}
}

// apelido de instancia (config instance_alias): quando uma instancia e renomeada,
// robos antigos que ainda chamam pelo nome velho continuam funcionando em vez de levar 404.
// O nome da instancia e sempre o ultimo segmento do path no Evolution v2.
function aliasUrl(url) {
  const i = url.indexOf('?');
  const p = i === -1 ? url : url.slice(0, i);
  const parts = p.split('/');
  const last = parts.length - 1;
  const alias = loadCfg().instance_alias || {};
  if (!alias[parts[last]]) return url;
  parts[last] = alias[parts[last]];
  return parts.join('/') + (i === -1 ? '' : url.slice(i));
}

// destino e GRUPO? (JID @g.us, legado com '-', ou id numerico longo de grupo)
function isGroup(dest) {
  if (!dest) return false;
  const s = String(dest);
  if (s.includes('@g.us')) return true;
  if (s.includes('@s.whatsapp.net')) return false;
  const core = s.split('@')[0];
  if (core.includes('-')) return true;
  return /^\d+$/.test(core) && core.length >= 15;
}
function core(dest) { return String(dest || '').split('@')[0]; }

function readBody(req) {
  return new Promise((res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', () => res(Buffer.concat(chunks)));
  });
}

// encaminha (method/path/query/headers preservados; Host preservado p/ o Traefik rotear)
function forward(req, bodyBuf, res, extra) {
  const c = loadCfg();
  const headers = Object.assign({}, req.headers);
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  headers['content-length'] = Buffer.byteLength(bodyBuf);
  const up = http.request({
    host: c.upstream_host || '127.0.0.1', port: c.upstream_port || 8080,
    method: req.method, path: req.url, headers,
  }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => { log({ kind: 'upstream_error', err: String(e), url: req.url }); if (!res.headersSent) res.writeHead(502); res.end('wa-guard upstream error'); });
  up.end(bodyBuf);
}

// dispara um sendText avulso (usado p/ alertar o dono quando um envio de midia e bloqueado)
function fireAlert(instance, apikey, text) {
  const c = loadCfg();
  const payload = Buffer.from(JSON.stringify({ number: c.owner_dm, text }));
  const r = http.request({ host: c.upstream_host || '127.0.0.1', port: c.upstream_port || 8080,
    method: 'POST', path: `/message/sendText/${instance}`,
    headers: { 'content-type': 'application/json', 'apikey': apikey || '', 'host': c.upstream_host_header || 'localhost', 'content-length': payload.length } });
  r.on('error', () => {}); r.end(payload);
}

// Entrega ao roteador (config router_url) um envio retido, para ele decidir e reemitir.
function handoffToRouter(payload) {
  const u = new URL(loadCfg().router_url);
  const body = Buffer.from(JSON.stringify(payload));
  const r = http.request({ host: u.hostname, port: u.port || 80, method: 'POST', path: u.pathname,
    headers: { 'content-type': 'application/json', 'content-length': body.length } });
  r.on('error', (e) => log({ kind: 'router_handoff_error', err: String(e), robot: payload.robot, destination: payload.destination }));
  r.end(body);
}

const server = http.createServer(async (req, res) => {
  const c = loadCfg();
  if (req.url === '/__guard/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, enforce: !!c.enforce })); }

  const aliased = aliasUrl(req.url);
  if (aliased !== req.url) { log({ kind: 'instance_alias', from: req.url, to: aliased, robot: (req.headers['x-wa-robot'] || null), ip: req.headers['x-real-ip'] || req.socket.remoteAddress }); req.url = aliased; }

  const m = req.url.match(/^\/message\/send[^/]+\/([^/?]+)/i);
  const bodyBuf = await readBody(req);

  // nao e endpoint de envio -> passthrough transparente
  if (!m) return forward(req, bodyBuf, res);

  const instance = decodeURIComponent(m[1]);
  const robot = (req.headers['x-wa-robot'] || '').toString().trim().toLowerCase() || null;
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;

  let parsed = null; try { parsed = JSON.parse(bodyBuf.toString('utf8')); } catch (e) {}
  const dest = parsed && (parsed.number != null ? String(parsed.number) : null);

  // Se houver roteador configurado (router_robot + router_url), so ele envia direto.
  // Tudo o que vier de outros scripts/agentes e retido e entregue a ele para decidir e reemitir.
  // Excecao: robos em direct_robots falam direto nos grupos registrados para eles em groups_by_robot.
  const direct = !!(robot && (c.direct_robots || []).includes(robot) && dest != null && isGroup(dest)
    && ((c.groups_by_robot || {})[robot] || {}).groups && c.groups_by_robot[robot].groups.includes(core(dest)));
  if (c.router_robot && c.router_url && parsed && dest != null && robot !== c.router_robot && !direct) {
    const text = typeof parsed.text === 'string' ? parsed.text : `[Mídia retida: ${parsed.mediatype || 'tipo desconhecido'}]`;
    handoffToRouter({ destination: dest, text, robot, endpoint: req.url, instance });
    log({ kind: 'held_for_router', instance, robot, dest: core(dest), endpoint: req.url });
    res.writeHead(201, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ key: { id: `held-by-router-${Date.now()}` }, status: 'held_for_router' }));
  }

  // corpo nao parseavel / sem number -> fail-open (vazamento de grupo exige number parseavel)
  if (!parsed || dest == null) { log({ kind: 'passthrough_unparsed', instance, robot, url: req.url, ip }); return forward(req, bodyBuf, res); }

  const grp = isGroup(dest);
  const cr = core(dest);

  if (!grp) { log({ kind: 'dm_allow', instance, robot, dest: cr, ip }); return forward(req, bodyBuf, res); }

  // ---- destino e GRUPO: decidir ----
  let allowed = false, basis = 'none';
  const byRobot = c.groups_by_robot || {};
  const byInst = c.groups_by_instance || {};
  if (robot && byRobot[robot]) {
    basis = 'robot';
    allowed = Array.isArray(byRobot[robot].groups) && byRobot[robot].groups.includes(cr)
              && (!byRobot[robot].instance || byRobot[robot].instance === instance);
  } else {
    basis = robot ? 'instance(robot-desconhecido)' : 'instance';
    allowed = Array.isArray(byInst[instance]) && byInst[instance].includes(cr);
  }

  if (allowed) { log({ kind: 'group_allow', basis, instance, robot, dest: cr, ip }); return forward(req, bodyBuf, res); }

  // ---- GRUPO NAO PERMITIDO ----
  const snippet = typeof parsed.text === 'string' ? parsed.text.slice(0, 120) : ('[' + (parsed.mediatype || 'media/outro') + ']');
  if (!c.enforce) {
    log({ kind: 'group_WOULDBLOCK', basis, instance, robot, dest: cr, ip, snippet });
    return forward(req, bodyBuf, res); // SOMBRA: deixa passar, so registra
  }

  // ENFORCE: nao vai pro grupo errado
  if (typeof parsed.text === 'string') {
    const warn = `⚠️ [wa-guard] Envio bloqueado: destino de grupo nao-autorizado (${cr}) pela instancia "${instance}"${robot ? ` / robo "${robot}"` : ''}. Reroteado pro seu privado. Conteudo original abaixo:\n\n`;
    const newBody = Buffer.from(JSON.stringify(Object.assign({}, parsed, { number: c.owner_dm, text: warn + parsed.text })));
    log({ kind: 'group_BLOCK_reroute', basis, instance, robot, dest: cr, ip, snippet });
    return forward(req, newBody, res); // reroteia pro DM do dono, mesma instancia
  }
  // midia/audio: nao reroteia o binario; dropa + alerta texto pro dono
  fireAlert(instance, req.headers['apikey'], `⚠️ [wa-guard] Bloqueei um envio de ${parsed.mediatype || 'midia'} da instancia "${instance}"${robot ? ` / robo "${robot}"` : ''} para o grupo nao-autorizado ${cr}. (conteudo retido)`);
  log({ kind: 'group_BLOCK_drop', basis, instance, robot, dest: cr, ip, snippet });
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ status: 'blocked_by_wa_guard', reason: 'grupo nao-autorizado', dest: cr }));
});

const startCfg = loadCfg();
server.listen(startCfg.guard_port || 8088, '127.0.0.1', () => {
  console.log(`wa-guard ouvindo em 127.0.0.1:${startCfg.guard_port || 8088} | enforce=${!!startCfg.enforce} | upstream=${startCfg.upstream_host}:${startCfg.upstream_port}`);
});
