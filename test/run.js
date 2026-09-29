'use strict';
// Sobe um upstream falso (faz o papel da Evolution API) e um roteador falso,
// roda o guard contra eles e confere cada regra. Uso: node test/run.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const UP = 18080, ROUTER = 18711, GUARD = 18088;
const upstreamHits = [], routerHits = [];
const sink = (arr, status) => (req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', () => { arr.push({ url: req.url, body: b ? JSON.parse(b) : null }); res.writeHead(status); res.end('{}'); });
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
fs.copyFileSync(path.join(__dirname, '..', 'server.js'), path.join(dir, 'server.js'));
fs.mkdirSync(path.join(dir, 'logs'));
const baseCfg = {
  enforce: true, guard_port: GUARD, upstream_host: '127.0.0.1', upstream_port: UP, owner_dm: '5511000000000',
  groups_by_robot: { 'sales-bot': { instance: 'main', groups: ['120363000000000001'] } },
  groups_by_instance: {}, direct_robots: [], instance_alias: { oldname: 'main' },
};
const writeCfg = (extra) => fs.writeFileSync(path.join(dir, 'allowlist.json'), JSON.stringify({ ...baseCfg, ...extra }));

function send(instance, robot, body, endpoint = 'sendText') {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const headers = { 'content-type': 'application/json', 'content-length': data.length };
    if (robot) headers['x-wa-robot'] = robot;
    const r = http.request({ host: '127.0.0.1', port: GUARD, method: 'POST', path: `/message/${endpoint}/${instance}`, headers },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.end(data);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (arr) => arr[arr.length - 1];

(async () => {
  writeCfg({});
  const up = http.createServer(sink(upstreamHits, 201)).listen(UP);
  const router = http.createServer(sink(routerHits, 200)).listen(ROUTER);
  const guard = spawn('node', ['server.js'], { cwd: dir, stdio: 'ignore' });
  await wait(600);
  let n = 0; const ok = (name) => console.log(`ok ${++n} - ${name}`);
  try {
    await send('main', 'sales-bot', { number: '5511988887777', text: 'oi' });
    assert.strictEqual(last(upstreamHits).body.number, '5511988887777'); ok('mensagem individual passa');

    await send('main', 'sales-bot', { number: '120363000000000001@g.us', text: 'relatorio' });
    assert.strictEqual(last(upstreamHits).body.number, '120363000000000001@g.us'); ok('robo no grupo autorizado passa');

    await send('main', 'sales-bot', { number: '120363999999999999@g.us', text: 'segredo' });
    assert.strictEqual(last(upstreamHits).body.number, '5511000000000');
    assert.match(last(upstreamHits).body.text, /bloqueado/); ok('grupo nao autorizado: desvia pro dono');

    await send('main', null, { number: '120363000000000001@g.us', text: 'x' });
    assert.strictEqual(last(upstreamHits).body.number, '5511000000000'); ok('robo sem identificacao nao entra em grupo');

    const before = upstreamHits.length;
    const r = await send('main', 'sales-bot', { number: '120363999999999999@g.us', mediatype: 'audio', media: 'b64' }, 'sendMedia');
    await wait(200);
    assert.match(r.body, /blocked_by_wa_guard/);
    assert.ok(upstreamHits.slice(before).every((h) => h.body.number === '5511000000000' && !h.body.media)); ok('midia para grupo errado e descartada + dono avisado');

    await send('oldname', 'sales-bot', { number: '5511988887777', text: 'oi' });
    assert.match(last(upstreamHits).url, /\/main$/); ok('apelido de instancia renomeada');

    writeCfg({ enforce: false }); await wait(50);
    await send('main', 'sales-bot', { number: '120363999999999999@g.us', text: 'sombra' });
    assert.strictEqual(last(upstreamHits).body.number, '120363999999999999@g.us');
    assert.match(fs.readFileSync(path.join(dir, 'logs', 'guard.log'), 'utf8'), /group_WOULDBLOCK/); ok('modo sombra deixa passar e registra');

    writeCfg({ router_robot: 'router', router_url: `http://127.0.0.1:${ROUTER}/outbound` }); await wait(50);
    const u0 = upstreamHits.length;
    const h = await send('main', 'sales-bot', { number: '5511988887777', text: 'proposta' });
    await wait(200);
    assert.match(h.body, /held_for_router/); assert.strictEqual(upstreamHits.length, u0);
    assert.strictEqual(last(routerHits).body.text, 'proposta'); ok('com roteador: envio retido e entregue a ele');

    await send('main', 'router', { number: '5511988887777', text: 'aprovado' });
    assert.strictEqual(last(upstreamHits).body.text, 'aprovado'); ok('o proprio roteador envia direto');
    console.log(`\n${n} testes passaram`);
  } catch (e) { console.error('FALHOU:', e.message); process.exitCode = 1; }
  guard.kill(); up.close(); router.close(); fs.rmSync(dir, { recursive: true, force: true });
})();
