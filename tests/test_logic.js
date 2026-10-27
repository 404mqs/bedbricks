// tests/test_logic.js — Node.js, sin dependencias externas
const assert = require('assert');

// ── Funciones bajo test (redefinidas inline — lógica pura sin GAS APIs) ──────

const SYSTEM_PROMPT = "Actuá como Principal Data Engineer experto en PySpark y Databricks. " +
  "Analizá el error adjunto y devolvé un resumen ultra-conciso de máximo 3 viñetas: " +
  "1. Qué rompió, 2. Root cause probable, " +
  "3. Recomendación (Si aplica REPAIR directo o si requiere FIX de código obligatorio)";

function _buildLlmPayload(errorMessage) {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: errorMessage  }
    ],
    max_tokens: 512,
    temperature: 0
  };
}

function _parseLlmResponse(responseBody) {
  try {
    const data    = JSON.parse(responseBody);
    const content = data.choices[0].message.content;
    if (!content) return { summary: '[Diagnóstico no disponible]', is_code_error: false };
    const lc          = content.toLowerCase();
    const is_code_error = lc.includes('fix de código obligatorio') || lc.includes('requiere fix');
    return { summary: content, is_code_error };
  } catch (e) {
    return { summary: '[Diagnóstico no disponible — respuesta malformada]', is_code_error: false };
  }
}

function _parseFailedTask(runData) {
  if (!runData || !Array.isArray(runData.tasks)) return null;
  const failed = runData.tasks.find(t => t.state && t.state.result_state === 'FAILED');
  if (!failed) return null;
  return {
    task_key:      failed.task_key,
    state_message: (failed.state && failed.state.state_message) || ''
  };
}

function _buildRepairPayload(runId, taskKeys, latestRepairId) {
  var keys = Array.isArray(taskKeys) ? taskKeys : [taskKeys];
  var payload = { run_id: runId, rerun_tasks: keys, rerun_dependent_tasks: true };
  if (latestRepairId) payload.latest_repair_id = latestRepairId;
  return payload;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log('\n_buildLlmPayload');
test('T1: mensaje usuario contiene el traceback', () => {
  const p = _buildLlmPayload('AnalysisException: Table not found');
  assert.ok(p.messages[1].content.includes('AnalysisException'));
});
test('T2: estructura correcta para Databricks Serving', () => {
  const p = _buildLlmPayload('any error');
  assert.strictEqual(p.messages[0].role, 'system');
  assert.strictEqual(p.messages[1].role, 'user');
  assert.strictEqual(p.max_tokens, 512);
  assert.strictEqual(p.temperature, 0);
});

console.log('\n_parseLlmResponse');
test('T3: extrae summary de choices[0].message.content', () => {
  const body = JSON.stringify({ choices: [{ message: { content: '• OOM\n• GC overhead\n• REPAIR directo' } }] });
  const r = _parseLlmResponse(body);
  assert.ok(r.summary.length > 0);
});
test('T4: detecta "requiere FIX de código obligatorio" → is_code_error=true', () => {
  const body = JSON.stringify({ choices: [{ message: { content: '• KeyError\n• campo eliminado\n• requiere FIX de código obligatorio' } }] });
  const r = _parseLlmResponse(body);
  assert.strictEqual(r.is_code_error, true);
});
test('T5: "REPAIR directo" → is_code_error=false', () => {
  const body = JSON.stringify({ choices: [{ message: { content: '• OOM\n• heap\n• REPAIR directo' } }] });
  const r = _parseLlmResponse(body);
  assert.strictEqual(r.is_code_error, false);
});
test('T6: JSON malformado → no throw, devuelve fallback', () => {
  const r = _parseLlmResponse('not json{{{');
  assert.ok(typeof r.summary === 'string');
  assert.strictEqual(r.is_code_error, false);
});

console.log('\n_parseFailedTask');
test('T7: extrae task_key + state_message de la task FAILED', () => {
  const run = { tasks: [
    { task_key: 'customers',       state: { result_state: 'SUCCESS' } },
    { task_key: 'transactions_etl',  state: { result_state: 'FAILED', state_message: 'AnalysisException: Table not found' } }
  ]};
  const r = _parseFailedTask(run);
  assert.strictEqual(r.task_key, 'transactions_etl');
  assert.ok(r.state_message.includes('AnalysisException'));
});
test('T8: múltiples tasks, extrae solo la FAILED', () => {
  const run = { tasks: [
    { task_key: 'task_a', state: { result_state: 'SUCCESS' } },
    { task_key: 'task_b', state: { result_state: 'SUCCESS' } },
    { task_key: 'task_c', state: { result_state: 'FAILED', state_message: 'boom' } }
  ]};
  const r = _parseFailedTask(run);
  assert.strictEqual(r.task_key, 'task_c');
});
test('T9: sin task FAILED → null', () => {
  const run = { tasks: [{ task_key: 'task_a', state: { result_state: 'RUNNING' } }] };
  const r = _parseFailedTask(run);
  assert.strictEqual(r, null);
});

console.log('\n_buildRepairPayload');
test('T10: string → rerun_tasks array de 1, con rerun_dependent_tasks', () => {
  const p = _buildRepairPayload(99999, 'transactions_etl');
  assert.strictEqual(p.run_id, 99999);
  assert.deepStrictEqual(p.rerun_tasks, ['transactions_etl']);
  assert.strictEqual(p.rerun_dependent_tasks, true);
});
test('T10b: array NO se anida (fix bug 400 MALFORMED_REQUEST)', () => {
  const p = _buildRepairPayload(1, ['a', 'b']);
  assert.deepStrictEqual(p.rerun_tasks, ['a', 'b']);   // NO [['a','b']]
});
test('T10c: latest_repair_id se incluye solo si está presente', () => {
  const sin = _buildRepairPayload(1, ['a']);
  assert.ok(!('latest_repair_id' in sin));
  const con = _buildRepairPayload(1, ['a'], 555);
  assert.strictEqual(con.latest_repair_id, 555);
});

// ── Nova v2 helpers ───────────────────────────────────────────────────────────

function _parseFavorites(json) {
  try { var a = JSON.parse(json || '[]'); return Array.isArray(a) ? a.map(String) : []; }
  catch(e) { return []; }
}
function _toggleFavoriteLogic(favorites, jobId) {
  var id = String(jobId); var idx = favorites.indexOf(id);
  if (idx === -1) return favorites.concat([id]);
  return favorites.filter(function(x) { return x !== id; });
}
function _buildCancelPayload(runId) { return { run_id: runId }; }
function _buildFixLogEntry(notebookPath, find, replace, ts) {
  return { ts: ts || 'NOW', notebook_path: notebookPath,
           find_preview: String(find).substring(0, 80), replace_preview: String(replace).substring(0, 80) };
}
function _appendFixLog(currentJson, entry) {
  var log = []; try { log = JSON.parse(currentJson || '[]'); } catch(e) {}
  if (!Array.isArray(log)) log = [];
  log.push(entry);
  if (log.length > 50) log = log.slice(log.length - 50);
  return log;
}
function _parseRunHistory(runs) {
  return (runs || []).map(function(r) {
    return { run_id: r.run_id,
             result_state:     (r.state && r.state.result_state)     || '',
             life_cycle_state: (r.state && r.state.life_cycle_state) || '',
             start_time:  r.start_time         || 0,
             duration_ms: r.execution_duration || 0 };
  });
}

console.log('\n_parseFavorites');
test('_parseFavorites: JSON válido retorna array de strings', function() {
  var r = _parseFavorites('[123,456]');
  assert(r.length === 2 && r[0] === '123' && r[1] === '456', 'expected ["123","456"], got ' + JSON.stringify(r));
});

test('_parseFavorites: JSON inválido retorna array vacío', function() {
  var r = _parseFavorites('NOT_JSON');
  assert(r.length === 0, 'expected [], got ' + JSON.stringify(r));
});

console.log('\n_toggleFavoriteLogic');
test('_toggleFavoriteLogic: agrega jobId si no está', function() {
  var r = _toggleFavoriteLogic(['111'], 222);
  assert(r.indexOf('222') !== -1, 'expected 222 in result, got ' + JSON.stringify(r));
});

test('_toggleFavoriteLogic: quita jobId si ya está', function() {
  var r = _toggleFavoriteLogic(['111','222'], 111);
  assert(r.indexOf('111') === -1 && r.indexOf('222') !== -1, 'expected 111 removed, got ' + JSON.stringify(r));
});

console.log('\n_buildCancelPayload');
test('_buildCancelPayload: retorna objeto con run_id', function() {
  var r = _buildCancelPayload(99999);
  assert(r.run_id === 99999, 'expected run_id=99999, got ' + JSON.stringify(r));
});

console.log('\n_appendFixLog');
test('_appendFixLog: agrega entrada y trunca a 50', function() {
  var log = [];
  for (var i = 0; i < 50; i++) log.push({ ts: 'T', notebook_path: 'x', find_preview: 'a', replace_preview: 'b' });
  var newEntry = _buildFixLogEntry('/nb/test', 'old_code', 'new_code', '2026-06-05T00:00:00Z');
  var updated = _appendFixLog(JSON.stringify(log), newEntry);
  assert(updated.length === 50, 'expected length 50, got ' + updated.length);
  assert(updated[49].notebook_path === '/nb/test', 'expected last entry to be new');
});

console.log('\n_parseRunHistory');
test('_parseRunHistory: mapea runs a objetos simplificados', function() {
  var runs = [
    { run_id: 1, state: { result_state: 'SUCCESS', life_cycle_state: 'TERMINATED' }, start_time: 1000, execution_duration: 5000 },
    { run_id: 2, state: { result_state: 'FAILED',  life_cycle_state: 'TERMINATED' }, start_time: 2000, execution_duration: 3000 }
  ];
  var r = _parseRunHistory(runs);
  assert(r.length === 2 && r[0].result_state === 'SUCCESS' && r[1].result_state === 'FAILED', JSON.stringify(r));
});

// ── Config helpers (inline for test file) ────────────────────────────────────
function _parseConfig(json) {
  var defaults = { host: '', auth: 'oauth', client_id: '', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '', lang: 'en' };
  try {
    var c = JSON.parse(json || '{}');
    return {
      host:            String(c.host            || defaults.host),
      auth:            (c.auth === 'pat' || (!c.auth && c.token)) ? 'pat' : 'oauth',
      client_id:       String(c.client_id       || defaults.client_id),
      token:           String(c.token           || defaults.token),
      llm_endpoint:    String(c.llm_endpoint    || defaults.llm_endpoint),
      pinned_job_id:   String(c.pinned_job_id   || defaults.pinned_job_id),
      pinned_job_name: String(c.pinned_job_name || defaults.pinned_job_name),
      lang:            String(c.lang            || defaults.lang)
    };
  } catch(e) { return defaults; }
}
function _isConfigComplete(config) {
  return !!(config.host && (config.auth === 'pat' ? config.token : true));
}
function _normHost(host) {
  var h = String(host || '').trim().replace(/\/+$/, '');
  if (h && !/^https?:\/\//i.test(h)) h = 'https://' + h;
  return h;
}
function _oauthServiceName(host) {
  return 'dbx_' + _normHost(host).replace(/^https?:\/\//i, '').replace(/[^A-Za-z0-9]/g, '_');
}
function _stripClientSecret(payload) {
  delete payload.client_secret;
  return payload;
}
function _sanitizeForRequireOAuth(multi) {
  var changed = false;
  (multi.workspaces || []).forEach(function(w) {
    if (w.auth !== 'oauth' || w.token) { w.auth = 'oauth'; w.token = ''; changed = true; }
  });
  return changed;
}
function _parseServingEndpoints(data) {
  return (data.endpoints || [])
    .filter(function(e) { return e.state && e.state.ready === 'READY'; })
    .map(function(e) { return e.name; });
}

console.log('\n_parseConfig');
test('_parseConfig: empty string returns defaults', function() {
  var c = _parseConfig('');
  assert(c.host === '' && c.token === '' && c.llm_endpoint === '' && c.pinned_job_id === '', JSON.stringify(c));
});
test('_parseConfig: valid JSON merges over defaults', function() {
  var c = _parseConfig('{"host":"https://adb-123.net","token":"dapi123","llm_endpoint":"ep1"}');
  assert(c.host === 'https://adb-123.net' && c.token === 'dapi123' && c.llm_endpoint === 'ep1', JSON.stringify(c));
});
test('_parseConfig: invalid JSON returns defaults', function() {
  var c = _parseConfig('NOT_JSON');
  assert(c.host === '' && c.token === '', JSON.stringify(c));
});

// ── _parseMultiConfig (multi-workspace) ───────────────────────────────────────
function _parseMultiConfig(json) {
  var raw;
  try { raw = JSON.parse(json || '{}'); } catch(e) { raw = {}; }
  if (!raw || typeof raw !== 'object') raw = {};
  var lang = String(raw.lang || 'en');
  var workspaces;
  if (Array.isArray(raw.workspaces)) {
    workspaces = raw.workspaces.map(function(w, i) {
      var n = _parseConfig(JSON.stringify(w || {}));
      return { name: String((w && w.name) || ('Workspace ' + (i + 1))), host: n.host, auth: n.auth,
               client_id: n.client_id, token: n.token,
               llm_endpoint: n.llm_endpoint, pinned_job_id: n.pinned_job_id, pinned_job_name: n.pinned_job_name };
    });
  } else if (raw.host || raw.token) {
    var n = _parseConfig(json);
    workspaces = [{ name: 'Workspace 1', host: n.host, auth: n.auth, client_id: n.client_id, token: n.token,
                    llm_endpoint: n.llm_endpoint, pinned_job_id: n.pinned_job_id, pinned_job_name: n.pinned_job_name }];
  } else {
    workspaces = [];
  }
  var active = parseInt(raw.active, 10);
  if (isNaN(active) || active < 0 || active >= workspaces.length) active = 0;
  return { active: active, lang: lang, workspaces: workspaces };
}

console.log('\n_parseMultiConfig');
test('MC1: config vacío → 0 workspaces, active 0', function() {
  var m = _parseMultiConfig('{}');
  assert.strictEqual(m.workspaces.length, 0);
  assert.strictEqual(m.active, 0);
});
test('MC2: migra config viejo (single) → workspaces[0]', function() {
  var m = _parseMultiConfig('{"host":"https://adb-1.net","token":"dapi1","llm_endpoint":"ep","lang":"es","pinned_job_id":"99"}');
  assert.strictEqual(m.workspaces.length, 1);
  assert.strictEqual(m.workspaces[0].host, 'https://adb-1.net');
  assert.strictEqual(m.workspaces[0].token, 'dapi1');
  assert.strictEqual(m.workspaces[0].pinned_job_id, '99');
  assert.strictEqual(m.workspaces[0].name, 'Workspace 1');
  assert.strictEqual(m.lang, 'es');
});
test('MC3: estructura multi se preserva', function() {
  var m = _parseMultiConfig('{"active":1,"lang":"en","workspaces":[{"name":"A","host":"h1","token":"t1"},{"name":"B","host":"h2","token":"t2"}]}');
  assert.strictEqual(m.workspaces.length, 2);
  assert.strictEqual(m.active, 1);
  assert.strictEqual(m.workspaces[1].name, 'B');
});
test('MC4: active fuera de rango se clampa a 0', function() {
  var m = _parseMultiConfig('{"active":5,"workspaces":[{"name":"A","host":"h","token":"t"}]}');
  assert.strictEqual(m.active, 0);
});
test('MC5: workspace sin name recibe default por índice', function() {
  var m = _parseMultiConfig('{"workspaces":[{"host":"h","token":"t"}]}');
  assert.strictEqual(m.workspaces[0].name, 'Workspace 1');
});

console.log('\n_isConfigComplete');
test('_isConfigComplete: PAT true when host and token present', function() {
  assert(_isConfigComplete({ host: 'https://adb.net', auth: 'pat', token: 'dapi', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' }) === true);
});
test('_isConfigComplete: PAT false when token missing', function() {
  assert(_isConfigComplete({ host: 'https://adb.net', auth: 'pat', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' }) === false);
});
test('_isConfigComplete: false when host missing', function() {
  assert(_isConfigComplete({ host: '', auth: 'pat', token: 'dapi', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' }) === false);
});
test('_isConfigComplete: OAuth only needs the host (the token comes from Connect)', function() {
  assert(_isConfigComplete({ host: 'https://adb-demo.azuredatabricks.net', auth: 'oauth', token: '' }) === true);
});

console.log('\nOAuth (per-user, PKCE)');
test('OA1: config viejo con token y sin auth sigue siendo PAT', function() {
  var m = _parseMultiConfig('{"workspaces":[{"name":"A","host":"https://adb-demo.azuredatabricks.net","token":"dapi1"}]}');
  assert.strictEqual(m.workspaces[0].auth, 'pat');
});
test('OA2: workspace nuevo sin token es OAuth y conserva su client_id', function() {
  var m = _parseMultiConfig('{"workspaces":[{"name":"A","host":"https://adb-demo.azuredatabricks.net","client_id":"abc"}]}');
  assert.strictEqual(m.workspaces[0].auth, 'oauth');
  assert.strictEqual(m.workspaces[0].client_id, 'abc');
});
test('OA3: auth explícito pat sin token se respeta', function() {
  var m = _parseMultiConfig('{"workspaces":[{"name":"A","host":"h","auth":"pat"}]}');
  assert.strictEqual(m.workspaces[0].auth, 'pat');
});
test('OA4: REQUIRE_OAUTH borra los PAT guardados y pasa todo a OAuth', function() {
  var m = _parseMultiConfig('{"workspaces":[{"name":"A","host":"h1","token":"dapi1"},{"name":"B","host":"h2","auth":"oauth"}]}');
  assert.strictEqual(_sanitizeForRequireOAuth(m), true);
  assert.deepStrictEqual(m.workspaces.map(function(w) { return [w.auth, w.token]; }), [['oauth', ''], ['oauth', '']]);
  assert.strictEqual(_sanitizeForRequireOAuth(m), false, 'segunda pasada no cambia nada (no reescribe en cada apertura)');
});
test('OA5: el token request de un cliente público va sin client_secret', function() {
  var p = _stripClientSecret({ code: 'c', client_id: 'id', client_secret: undefined, code_verifier: 'v', grant_type: 'authorization_code' });
  assert.ok(!('client_secret' in p));
  assert.strictEqual(p.code_verifier, 'v');
});
test('OA6: _normHost agrega https y saca la barra final', function() {
  assert.strictEqual(_normHost('adb-demo.azuredatabricks.net/'), 'https://adb-demo.azuredatabricks.net');
  assert.strictEqual(_normHost(' https://adb-demo.azuredatabricks.net// '), 'https://adb-demo.azuredatabricks.net');
  assert.strictEqual(_normHost(''), '');
});
test('OA7: un servicio OAuth por host, mismo nombre con o sin https/barra', function() {
  assert.strictEqual(_oauthServiceName('https://adb-demo.azuredatabricks.net/'), 'dbx_adb_demo_azuredatabricks_net');
  assert.strictEqual(_oauthServiceName('adb-demo.azuredatabricks.net'), 'dbx_adb_demo_azuredatabricks_net');
  assert.notStrictEqual(_oauthServiceName('https://adb-a.net'), _oauthServiceName('https://adb-b.net'));
});

console.log('\n_parseServingEndpoints');
test('_parseServingEndpoints: returns only READY endpoint names', function() {
  var data = { endpoints: [
    { name: 'ep-ready',     state: { ready: 'READY' } },
    { name: 'ep-not-ready', state: { ready: 'NOT_READY' } }
  ]};
  var r = _parseServingEndpoints(data);
  assert(r.length === 1 && r[0] === 'ep-ready', JSON.stringify(r));
});
test('_parseServingEndpoints: empty/missing data returns empty array', function() {
  assert(_parseServingEndpoints({}).length === 0);
  assert(_parseServingEndpoints({ endpoints: [] }).length === 0);
});

// ── _computeFlakiness (inline para tests) ─────────────────────────────────────
function _computeFlakiness(runsWithTasks) {
  var counts = {};
  for (var i = 0; i < runsWithTasks.length; i++) {
    var tasks = runsWithTasks[i].tasks || [];
    for (var j = 0; j < tasks.length; j++) {
      var key = tasks[j].task_key;
      if (!counts[key]) counts[key] = { total: 0, failed: 0 };
      counts[key].total++;
      var rs = tasks[j].result_state;
      if (rs === 'FAILED' || rs === 'TIMEDOUT') counts[key].failed++;
    }
  }
  var result = {};
  var keys = Object.keys(counts);
  for (var k = 0; k < keys.length; k++) {
    var c = counts[keys[k]];
    if (c.total >= 3) result[keys[k]] = { total: c.total, failed: c.failed, rate: c.failed / c.total };
  }
  return result;
}

console.log('\n_computeFlakiness');
test('CF1: array vacío devuelve objeto vacío', function() {
  assert.deepStrictEqual(_computeFlakiness([]), {});
});
test('CF2: una task 0/3 fallas → rate 0', function() {
  var runs = [
    { tasks: [{ task_key: 'customers', result_state: 'SUCCESS' }] },
    { tasks: [{ task_key: 'customers', result_state: 'SUCCESS' }] },
    { tasks: [{ task_key: 'customers', result_state: 'SUCCESS' }] }
  ];
  var r = _computeFlakiness(runs);
  assert.strictEqual(r['customers'].rate, 0);
  assert.strictEqual(r['customers'].total, 3);
  assert.strictEqual(r['customers'].failed, 0);
});
test('CF3: una task 2/4 fallas → rate 0.5', function() {
  var runs = [
    { tasks: [{ task_key: 'customers', result_state: 'FAILED' }] },
    { tasks: [{ task_key: 'customers', result_state: 'SUCCESS' }] },
    { tasks: [{ task_key: 'customers', result_state: 'FAILED' }] },
    { tasks: [{ task_key: 'customers', result_state: 'SUCCESS' }] }
  ];
  var r = _computeFlakiness(runs);
  assert.strictEqual(r['customers'].rate, 0.5);
});
test('CF4: TIMEDOUT cuenta como falla', function() {
  var runs = [
    { tasks: [{ task_key: 'task_a', result_state: 'TIMEDOUT' }] },
    { tasks: [{ task_key: 'task_a', result_state: 'SUCCESS' }] },
    { tasks: [{ task_key: 'task_a', result_state: 'SUCCESS' }] }
  ];
  var r = _computeFlakiness(runs);
  assert.strictEqual(r['task_a'].failed, 1);
});
test('CF5: task con < 3 runs no aparece en resultado', function() {
  var runs = [
    { tasks: [{ task_key: 'rare_task', result_state: 'FAILED' }] },
    { tasks: [{ task_key: 'rare_task', result_state: 'FAILED' }] }
  ];
  var r = _computeFlakiness(runs);
  assert.strictEqual(r['rare_task'], undefined);
});
test('CF6: múltiples tasks en el mismo run se procesan todas', function() {
  var run = { tasks: [
    { task_key: 'task_a', result_state: 'SUCCESS' },
    { task_key: 'task_b', result_state: 'FAILED' }
  ]};
  var runs = [run, run, run];
  var r = _computeFlakiness(runs);
  assert.strictEqual(r['task_a'].rate, 0);
  assert.strictEqual(r['task_b'].rate, 1);
});

// ── _gestureDelta (inline para tests) ──────────────────────────────────────────
function _gestureDelta(startX, startY, endX, endY, scrollTop, hasRowTarget) {
  var dx = endX - startX;
  var dy = endY - startY;
  if (dy > 70 && Math.abs(dx) < 40 && scrollTop === 0) return 'pull-refresh';
  // Horizontal swipe-to-switch-tabs removed: it hijacked horizontal scroll
  // when reading full notebook code. Only swipe-on-a-row + pull-to-refresh remain.
  if (dx < -50 && Math.abs(dy) < 40 && hasRowTarget) return 'swipe-row-left';
  return 'none';
}

console.log('\n_gestureDelta');
test('GD1: pull-refresh — dy>70, |dx|<40, scrollTop=0', function() {
  assert.strictEqual(_gestureDelta(100, 0, 110, 80, 0, false), 'pull-refresh');
});
test('GD2: pull-refresh no dispara si scrollTop > 0', function() {
  assert.strictEqual(_gestureDelta(100, 0, 110, 80, 10, false), 'none');
});
test('GD3: swipe horizontal sin row target → none (swipe-tab removido)', function() {
  assert.strictEqual(_gestureDelta(200, 100, 130, 105, 50, false), 'none');
});
test('GD4: swipe horizontal opuesto sin row target → none (swipe-tab removido)', function() {
  assert.strictEqual(_gestureDelta(100, 100, 170, 105, 50, false), 'none');
});
test('GD5: swipe horizontal sobre job row con dy grande → none', function() {
  assert.strictEqual(_gestureDelta(200, 100, 130, 160, 50, true), 'none');
});
test('GD6: swipe-row-left — dx < -50, |dy|<40, con row target', function() {
  assert.strictEqual(_gestureDelta(200, 100, 140, 110, 50, true), 'swipe-row-left');
});
test('GD7: gesto demasiado corto → none', function() {
  assert.strictEqual(_gestureDelta(100, 100, 120, 105, 50, false), 'none');
});

// ── _buildManifest (inline para tests) ─────────────────────────────────────────
function _buildManifest(appUrl) {
  return {
    name:             'Bedbricks',
    short_name:       'Bedbricks',
    start_url:        appUrl,
    display:          'standalone',
    theme_color:      '#FF3621',
    background_color: '#0f0f0f',
    icons: [{ src: appUrl + '?page=icon', type: 'image/png', sizes: '192x192' }]
  };
}

console.log('\n_buildManifest');
test('BM1: name y short_name son "Bedbricks"', function() {
  var m = _buildManifest('https://script.google.com/macros/s/ABC/exec');
  assert.strictEqual(m.name, 'Bedbricks');
  assert.strictEqual(m.short_name, 'Bedbricks');
});
test('BM2: display es standalone', function() {
  var m = _buildManifest('https://app.url');
  assert.strictEqual(m.display, 'standalone');
});
test('BM3: start_url coincide con el arg', function() {
  var url = 'https://script.google.com/macros/s/XYZ/exec';
  var m = _buildManifest(url);
  assert.strictEqual(m.start_url, url);
});
test('BM4: icons tiene exactamente un entry con type image/png', function() {
  var m = _buildManifest('https://app.url');
  assert.strictEqual(m.icons.length, 1);
  assert.strictEqual(m.icons[0].type, 'image/png');
});
test('BM5: theme_color es #FF3621', function() {
  var m = _buildManifest('https://app.url');
  assert.strictEqual(m.theme_color, '#FF3621');
});

// ── _extractTaskMeta ─────────────────────────────────────────────────────────
function _extractTaskMeta(task) {
  if (!task) return { task_type: 'other', notebook_path: null, notebook_params: null, subjob_id: null };
  if (task.notebook_task) return {
    task_type: 'notebook',
    notebook_path: task.notebook_task.notebook_path || null,
    notebook_params: task.notebook_task.base_parameters || null,
    subjob_id: null
  };
  if (task.run_job_task) return {
    task_type: 'run_job',
    notebook_path: null,
    notebook_params: null,
    subjob_id: task.run_job_task.job_id || null
  };
  if (task.python_wheel_task) return { task_type: 'python_wheel', notebook_path: null, notebook_params: null, subjob_id: null };
  if (task.spark_python_task) return { task_type: 'spark_python', notebook_path: null, notebook_params: null, subjob_id: null };
  return { task_type: 'other', notebook_path: null, notebook_params: null, subjob_id: null };
}

function _getTaskChipType(task_type) {
  if (task_type === 'notebook') return 'code';
  if (task_type === 'run_job')  return 'subjob';
  return null;
}

console.log('\n_extractTaskMeta');
test('TC1: notebook_task con path → task_type notebook y notebook_path', function() {
  var m = _extractTaskMeta({ notebook_task: { notebook_path: '/Shared/ETL/customers' } });
  assert.strictEqual(m.task_type, 'notebook');
  assert.strictEqual(m.notebook_path, '/Shared/ETL/customers');
  assert.strictEqual(m.subjob_id, null);
});
test('TC2: run_job_task con job_id → task_type run_job y subjob_id', function() {
  var m = _extractTaskMeta({ run_job_task: { job_id: 912345678901234 } });
  assert.strictEqual(m.task_type, 'run_job');
  assert.strictEqual(m.subjob_id, 912345678901234);
  assert.strictEqual(m.notebook_path, null);
});
test('TC3: python_wheel_task → task_type python_wheel, notebook_path null', function() {
  var m = _extractTaskMeta({ python_wheel_task: { package_name: 'mylib' } });
  assert.strictEqual(m.task_type, 'python_wheel');
  assert.strictEqual(m.notebook_path, null);
});
test('TC4: task sin key conocida → task_type other', function() {
  var m = _extractTaskMeta({ some_other_task: {} });
  assert.strictEqual(m.task_type, 'other');
  assert.strictEqual(m.notebook_path, null);
});
test('TC5: notebook_task con base_parameters → notebook_params mapeado', function() {
  var m = _extractTaskMeta({ notebook_task: { notebook_path: '/p', base_parameters: { fecha_proceso: '2026-06-09', env: 'prod' } } });
  assert.strictEqual(m.notebook_params.fecha_proceso, '2026-06-09');
  assert.strictEqual(m.notebook_params.env, 'prod');
});

console.log('\n_getTaskChipType');
test('CC1: notebook → code', function() {
  assert.strictEqual(_getTaskChipType('notebook'), 'code');
});
test('CC2: run_job → subjob', function() {
  assert.strictEqual(_getTaskChipType('run_job'), 'subjob');
});
test('CC3: other → null (sin chip)', function() {
  assert.strictEqual(_getTaskChipType('other'), null);
});

// ── _parseFailedTasks (plural — igual que codigo.gs) ───────────────────────────
function _isSentinelTask(task) {
  if (!task) return false;
  var key = String(task.task_key || '').toLowerCase();
  if (key.indexOf('centinela') !== -1 || key.indexOf('sentinel') !== -1) return true;
  var msg = String(task.state_message || '').toLowerCase();
  return msg.indexOf('centinela') !== -1 || msg.indexOf('sentinel task') !== -1;
}

// Deteccion ESTRUCTURAL: un centinela es la HOJA del DAG que corre con run_if=ALL_DONE
// para forzar el run a FAILED. No depende del nombre -- el rename de
// un centinela sin la palabra 'centinela' en el nombre es invisible al match por
// substring, y en un job director las otras fallas son todas run_job (no se diagnostican)
// => el centinela quedaba siendo la UNICA task diagnosticada, justo la que no es la causa.
// Calibrado sobre el DAG real: de sus 3 tasks ALL_DONE solo el centinela es hoja, y hojas
// con >=2 deps hay exactamente una. El gate ancho (58 deps) tiene 59 dependientes => no es hoja.
function _sentinelKeys(allTasks) {
  var out = {};
  if (!Array.isArray(allTasks)) return out;
  var depended = {};
  for (var i = 0; i < allTasks.length; i++) {
    var deps = (allTasks[i] && allTasks[i].depends_on) || [];
    for (var d = 0; d < deps.length; d++) {
      if (deps[d] && deps[d].task_key) depended[deps[d].task_key] = true;
    }
  }
  for (var j = 0; j < allTasks.length; j++) {
    var t = allTasks[j];
    if (!t || !t.task_key) continue;
    if (_isSentinelTask(t)) { out[t.task_key] = true; continue; }
    var nd = (t.depends_on || []).length;
    if (t.run_if === 'ALL_DONE' && nd >= 2 && !depended[t.task_key]) out[t.task_key] = true;
  }
  return out;
}

function _sortFailedTasks(tasks, allTasks) {
  var extra = allTasks ? _sentinelKeys(allTasks) : {};
  var real = [], sentinels = [];
  for (var i = 0; i < (tasks || []).length; i++) {
    var t = tasks[i];
    if (_isSentinelTask(t) || !!(t && extra[t.task_key])) sentinels.push(t); else real.push(t);
  }
  var flag = real.length > 0;
  for (var a = 0; a < real.length; a++)      real[a].is_sentinel      = false;
  for (var b = 0; b < sentinels.length; b++) sentinels[b].is_sentinel = flag;
  return real.concat(sentinels);
}

// El run_id del hijo NO esta en runs/get: ahi run_job_output viene null. Sale de
// runs/get-output sobre el run_id de la TASK padre. Medido contra la API.
function _childRunId(outputPayload) {
  if (!outputPayload || !outputPayload.run_job_output) return null;
  var rid = outputPayload.run_job_output.run_id;
  return (typeof rid === 'number' && rid > 0) ? rid : null;
}

// getJobParams solo miraba notebook_task.base_parameters. Un job director cuyas tasks son
// todas run_job_task no tiene ni una, y su parametrizacion vive en settings.parameters
// (nivel job), que run_job_task SI propaga al hijo.
function _mergeJobParams(settings) {
  var merged = {};
  if (!settings) return merged;
  var jp = settings.parameters || [];
  for (var i = 0; i < jp.length; i++) {
    if (jp[i] && jp[i].name) merged[jp[i].name] = (jp[i]['default'] !== undefined) ? jp[i]['default'] : '';
  }
  var tasks = settings.tasks || [];
  for (var j = 0; j < tasks.length; j++) {
    var bp = tasks[j].notebook_task && tasks[j].notebook_task.base_parameters;
    if (bp) { for (var k in bp) { if (Object.prototype.hasOwnProperty.call(bp, k)) merged[k] = bp[k]; } }
  }
  return merged;
}

// Un run cuyas tasks son TODAS run_job es un director: la barra cuenta olas, no tasks,
// y rotularla "tasks" miente por dos ordenes de magnitud (7 en vez de ~174).
function _countsAreSubjobs(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return false;
  for (var i = 0; i < tasks.length; i++) {
    if (!tasks[i] || !tasks[i].run_job_task) return false;
  }
  return true;
}

function _parseFailedTasks(runData) {
  if (!runData || !Array.isArray(runData.tasks)) return [];
  var byKey = {}, order = [];
  for (var i = 0; i < runData.tasks.length; i++) {
    var t = runData.tasks[i];
    if (t.state && t.state.result_state === 'FAILED') {
      if (!byKey[t.task_key]) order.push(t.task_key);
      byKey[t.task_key] = {
        task_key:      t.task_key,
        task_run_id:   t.run_id || null,
        is_notebook:   !!(t.notebook_task),
        is_subjob:     !!(t.run_job_task),
        subjob_id:     (t.run_job_task && t.run_job_task.job_id) || null,
        state_message: (t.state && t.state.state_message) || ''
      };
    }
  }
  return _sortFailedTasks(order.map(function(k) { return byKey[k]; }), runData.tasks);
}

function _mergeRunPages(pages) {
  if (!pages || !pages.length || !pages[0]) return null;
  var base  = pages[0];
  var tasks = [];
  for (var i = 0; i < pages.length; i++) {
    if (pages[i] && Array.isArray(pages[i].tasks)) tasks = tasks.concat(pages[i].tasks);
  }
  var merged = {};
  for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) merged[k] = base[k];
  merged.tasks = tasks;
  delete merged.next_page_token;
  return merged;
}

function _dedupTasksByKey(tasks) {
  if (!Array.isArray(tasks)) return [];
  var byKey = {}, order = [];
  for (var i = 0; i < tasks.length; i++) {
    var k = tasks[i] && tasks[i].task_key;
    if (k === undefined || k === null) continue;
    if (!Object.prototype.hasOwnProperty.call(byKey, k)) order.push(k);
    byKey[k] = tasks[i];
  }
  return order.map(function(k) { return byKey[k]; });
}

function _runPageUrl(runId, pageToken) {
  return '/api/2.2/jobs/runs/get?run_id=' + runId +
         (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
}

console.log('\n_parseFailedTasks');
test('PF1: task run_job fallida captura subjob_id e is_subjob', function() {
  var run = { tasks: [
    { task_key: 'subjob_carga', state: { result_state: 'FAILED' }, run_job_task: { job_id: 912345678901235 } }
  ]};
  var r = _parseFailedTasks(run);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].is_subjob, true);
  assert.strictEqual(r[0].is_notebook, false);
  assert.strictEqual(r[0].subjob_id, 912345678901235);
});
test('PF2: task notebook fallida → is_notebook true, subjob_id null', function() {
  var run = { tasks: [
    { task_key: 'customers', state: { result_state: 'FAILED' }, notebook_task: { notebook_path: '/x' } }
  ]};
  var r = _parseFailedTasks(run);
  assert.strictEqual(r[0].is_notebook, true);
  assert.strictEqual(r[0].is_subjob, false);
  assert.strictEqual(r[0].subjob_id, null);
});
test('PF3: dedup por task_key — queda la última ocurrencia (repairs)', function() {
  var run = { tasks: [
    { task_key: 'task_x', state: { result_state: 'FAILED' }, notebook_task: { notebook_path: '/old' } },
    { task_key: 'task_x', state: { result_state: 'FAILED' }, run_job_task: { job_id: 123 } }
  ]};
  var r = _parseFailedTasks(run);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].subjob_id, 123);
});
test('PF4: sin tasks FAILED → array vacío', function() {
  var run = { tasks: [{ task_key: 'a', state: { result_state: 'SUCCESS' } }] };
  assert.deepStrictEqual(_parseFailedTasks(run), []);
});

// ── V6 helpers ─────────────────────────────────────────────────────────────────
function _buildRunComparison(runA, runB) {
  var keys = [], seen = {};
  function addKeys(run) { ((run && run.tasks) || []).forEach(function(t) { if (!seen[t.task_key]) { seen[t.task_key] = true; keys.push(t.task_key); } }); }
  addKeys(runA); addKeys(runB);
  function lookup(run, key) { var arr = (run && run.tasks) || []; for (var i = 0; i < arr.length; i++) if (arr[i].task_key === key) return arr[i]; return null; }
  return keys.map(function(k) {
    var a = lookup(runA, k), b = lookup(runB, k);
    var aDur = a ? (a.duration_ms || 0) : null;
    var bDur = b ? (b.duration_ms || 0) : null;
    return {
      task_key: k,
      a_state:  a ? (a.result_state || '') : null,
      b_state:  b ? (b.result_state || '') : null,
      a_dur:    aDur, b_dur: bDur,
      delta_ms: (aDur != null && bDur != null) ? (bDur - aDur) : null
    };
  });
}
function _globalSearch(query, jobs, runs) {
  var q = (query || '').toLowerCase().trim();
  if (!q) return [];
  var out = [];
  (jobs || []).forEach(function(j) {
    if (String(j.name || '').toLowerCase().indexOf(q) !== -1 || String(j.job_id).indexOf(q) !== -1)
      out.push({ type: 'job', job_id: j.job_id, job_name: j.name });
  });
  (runs || []).forEach(function(r) {
    if (String(r.run_id).indexOf(q) !== -1 || String(r.job_name || '').toLowerCase().indexOf(q) !== -1)
      out.push({ type: 'run', job_id: r.job_id, job_name: r.job_name, run_id: r.run_id });
  });
  return out;
}
function _paramsToMap(pairs) {
  var map = {};
  (pairs || []).forEach(function(p) {
    var k = (p && p.key != null) ? String(p.key).trim() : '';
    if (k) map[k] = (p.value != null) ? String(p.value) : '';
  });
  return map;
}
function _buildRunNowPayload(jobId, params) {
  var payload = { job_id: jobId };
  if (params && Object.keys(params).length) payload.notebook_params = params;
  return payload;
}

console.log('\n_buildRunComparison');
test('RC1: union de task keys de ambos runs', function() {
  var a = { tasks: [{ task_key: 't1', result_state: 'SUCCESS', duration_ms: 1000 }] };
  var b = { tasks: [{ task_key: 't1', result_state: 'SUCCESS', duration_ms: 1500 }, { task_key: 't2', result_state: 'FAILED', duration_ms: 200 }] };
  var r = _buildRunComparison(a, b);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].task_key, 't1');
  assert.strictEqual(r[0].delta_ms, 500);
});
test('RC2: task solo en B → a_state null, delta null', function() {
  var a = { tasks: [] };
  var b = { tasks: [{ task_key: 't2', result_state: 'SUCCESS', duration_ms: 300 }] };
  var r = _buildRunComparison(a, b);
  assert.strictEqual(r[0].a_state, null);
  assert.strictEqual(r[0].delta_ms, null);
  assert.strictEqual(r[0].b_dur, 300);
});
test('RC3: runs vacíos → array vacío', function() {
  assert.deepStrictEqual(_buildRunComparison({ tasks: [] }, { tasks: [] }), []);
});

console.log('\n_globalSearch');
test('GS1: query vacío → []', function() {
  assert.deepStrictEqual(_globalSearch('', [{ name: 'x', job_id: 1 }], []), []);
});
test('GS2: match por nombre de job (case-insensitive)', function() {
  var r = _globalSearch('orch', [{ name: 'Daily Orchestrator', job_id: 1 }], []);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].type, 'job');
});
test('GS3: match por run_id', function() {
  var r = _globalSearch('789', [], [{ run_id: 789723, job_id: 2, job_name: 'X' }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].type, 'run');
  assert.strictEqual(r[0].run_id, 789723);
});
test('GS4: match por job_id numérico', function() {
  var r = _globalSearch('678', [{ name: 'Foo', job_id: 912345678901234 }], []);
  assert.strictEqual(r.length, 1);
});

console.log('\n_paramsToMap');
test('PM1: pares válidos → map', function() {
  assert.deepStrictEqual(_paramsToMap([{ key: 'fecha', value: '2026-06-10' }, { key: 'modo', value: 'full' }]), { fecha: '2026-06-10', modo: 'full' });
});
test('PM2: keys vacías se ignoran', function() {
  assert.deepStrictEqual(_paramsToMap([{ key: '', value: 'x' }, { key: '  ', value: 'y' }, { key: 'ok', value: '1' }]), { ok: '1' });
});
test('PM3: value null → string vacío', function() {
  assert.deepStrictEqual(_paramsToMap([{ key: 'a', value: null }]), { a: '' });
});

console.log('\n_buildRunNowPayload');
test('RN1: sin params → solo job_id', function() {
  assert.deepStrictEqual(_buildRunNowPayload(123, {}), { job_id: 123 });
});
test('RN2: con params → incluye notebook_params', function() {
  assert.deepStrictEqual(_buildRunNowPayload(123, { fecha: '2026-06-10' }), { job_id: 123, notebook_params: { fecha: '2026-06-10' } });
});

// ── _buildHintBlock (inline para tests) ────────────────────────────────────────
function _buildHintBlock(userHint, lang) {
  var h = (userHint == null ? '' : String(userHint)).trim();
  if (!h) return '';
  if (h.length > 1000) h = h.substring(0, 1000);
  return lang === 'es'
    ? '\n\nPISTA DEL USUARIO (tenela MUY en cuenta — la dio quien conoce el pipeline):\n' + h
    : '\n\nUSER HINT (weigh it HEAVILY — provided by someone who knows the pipeline):\n' + h;
}

console.log('\n_buildHintBlock');
test('HB1: hint vacío → string vacío', function() {
  assert.strictEqual(_buildHintBlock('', 'en'), '');
});
test('HB2: hint null/undefined → string vacío', function() {
  assert.strictEqual(_buildHintBlock(null, 'es'), '');
  assert.strictEqual(_buildHintBlock(undefined, 'en'), '');
});
test('HB3: hint solo espacios → string vacío', function() {
  assert.strictEqual(_buildHintBlock('   \n  ', 'en'), '');
});
test('HB4: hint en inglés usa prefijo USER HINT y contiene el texto', function() {
  var r = _buildHintBlock('the table was renamed to analytics.customers_v2', 'en');
  assert.ok(r.indexOf('USER HINT') !== -1);
  assert.ok(r.indexOf('the table was renamed to analytics.customers_v2') !== -1);
});
test('HB5: hint en español usa prefijo PISTA DEL USUARIO', function() {
  var r = _buildHintBlock('la tabla se renombró', 'es');
  assert.ok(r.indexOf('PISTA DEL USUARIO') !== -1);
  assert.ok(r.indexOf('la tabla se renombró') !== -1);
});
test('HB6: hint se recorta a 1000 chars', function() {
  var long = new Array(2000).fill('x').join('');
  var r = _buildHintBlock(long, 'en');
  // el bloque = prefijo + 1000 x; verificamos que solo hay 1000 'x'
  assert.strictEqual((r.match(/x/g) || []).length, 1000);
});
test('HB7: hint se trimea antes de inyectar', function() {
  var r = _buildHintBlock('  hola  ', 'es');
  assert.ok(r.endsWith('hola'));
});

// -- v79: paginacion de runs/get + despriorizacion del centinela ---------------
console.log('\n_mergeRunPages / _runPageUrl');
test('MP1: concatena las tasks de todas las paginas', function() {
  var r = _mergeRunPages([
    { run_id: 9, state: { result_state: 'FAILED' }, tasks: [{ task_key: 'a' }, { task_key: 'b' }], next_page_token: 'tok' },
    { run_id: 9, tasks: [{ task_key: 'c' }] }
  ]);
  assert.strictEqual(r.tasks.length, 3);
  assert.deepStrictEqual(r.tasks.map(function(t){return t.task_key;}), ['a','b','c']);
});
test('MP2: conserva los campos top-level de la pagina 1 y dropea next_page_token', function() {
  var r = _mergeRunPages([{ run_id: 9, start_time: 100, state: { result_state: 'FAILED' }, tasks: [], next_page_token: 'tok' }]);
  assert.strictEqual(r.run_id, 9);
  assert.strictEqual(r.start_time, 100);
  assert.strictEqual(r.state.result_state, 'FAILED');
  assert.strictEqual(r.next_page_token, undefined);
});
test('MP3: sin paginas -> null', function() {
  assert.strictEqual(_mergeRunPages([]), null);
  assert.strictEqual(_mergeRunPages(null), null);
});
test('MP4: pagina sin array tasks no rompe', function() {
  var r = _mergeRunPages([{ run_id: 1 }, { run_id: 1, tasks: [{ task_key: 'x' }] }]);
  assert.strictEqual(r.tasks.length, 1);
});
test('MP5: _runPageUrl usa 2.2 y omite page_token en la primera pagina', function() {
  assert.strictEqual(_runPageUrl(77, null), '/api/2.2/jobs/runs/get?run_id=77');
  assert.strictEqual(_runPageUrl(77, 'a b'), '/api/2.2/jobs/runs/get?run_id=77&page_token=a%20b');
});

console.log('\n_isSentinelTask / _sortFailedTasks');
test('SN1: detecta el centinela por substring del task_key (ES y EN)', function() {
  assert.strictEqual(_isSentinelTask({ task_key: 'CENTINELA_FALLAS_DAG' }), true);
  assert.strictEqual(_isSentinelTask({ task_key: 'sentinel_check' }), true);
  assert.strictEqual(_isSentinelTask({ task_key: 'daily_load' }), false);
});
test('SN2: detecta el centinela por el mensaje si el nombre no lo delata', function() {
  assert.strictEqual(_isSentinelTask({ task_key: 'GUARD_FINAL', state_message: 'el run figura FAILED porque el CENTINELA lo marca a proposito' }), true);
});
test('SN3: los centinelas van al final y las reales quedan primero, en orden', function() {
  var r = _sortFailedTasks([
    { task_key: 'CENTINELA_FALLAS_DAG' },
    { task_key: 'daily_load' },
    { task_key: 'genera_informe_diario' }
  ]);
  assert.deepStrictEqual(r.map(function(t){return t.task_key;}),
    ['daily_load','genera_informe_diario','CENTINELA_FALLAS_DAG']);
  assert.strictEqual(r[0].is_sentinel, false);
  assert.strictEqual(r[2].is_sentinel, true);
});
console.log('\n_sentinelKeys (deteccion estructural)');
// Forma del director: N olas run_job + un centinela ALL_DONE que es la hoja.
var DAG_DIRECTOR = [
  { task_key: 'OLA_1', run_if: 'ALL_SUCCESS', depends_on: [], run_job_task: { job_id: 1 } },
  { task_key: 'OLA_2', run_if: 'ALL_SUCCESS', depends_on: [{ task_key: 'OLA_1' }], run_job_task: { job_id: 2 } },
  { task_key: 'OLA_3', run_if: 'ALL_SUCCESS', depends_on: [{ task_key: 'OLA_2' }], run_job_task: { job_id: 3 } },
  { task_key: 'WRAP_UP_CHECK', run_if: 'ALL_DONE',
    depends_on: [{ task_key: 'OLA_1' }, { task_key: 'OLA_2' }, { task_key: 'OLA_3' }],
    notebook_task: { notebook_path: '/nb/cierre' } }
];
test('SK1: WRAP_UP_CHECK se detecta SIN que el nombre diga centinela', function() {
  assert.strictEqual(_isSentinelTask({ task_key: 'WRAP_UP_CHECK' }), false, 'por nombre NO debe pegar');
  assert.strictEqual(_sentinelKeys(DAG_DIRECTOR)['WRAP_UP_CHECK'], true);
});
test('SK2: las olas run_job NO son centinelas', function() {
  var k = _sentinelKeys(DAG_DIRECTOR);
  assert.strictEqual(k['OLA_1'], undefined);
  assert.strictEqual(k['OLA_2'], undefined);
  assert.strictEqual(k['OLA_3'], undefined);
});
test('SK3: un gate ALL_DONE ancho NO es centinela -- tiene dependientes', function() {
  var dag = [
    { task_key: 'A', depends_on: [] },
    { task_key: 'B', depends_on: [] },
    { task_key: 'GATE', run_if: 'ALL_DONE', depends_on: [{ task_key: 'A' }, { task_key: 'B' }] },
    { task_key: 'HIJA', depends_on: [{ task_key: 'GATE' }] }
  ];
  assert.strictEqual(_sentinelKeys(dag)['GATE'], undefined);
});
test('SK4: una hoja ALL_DONE con 1 sola dep NO es centinela (es un reporte)', function() {
  var dag = [
    { task_key: 'A', depends_on: [] },
    { task_key: 'REPORTE', run_if: 'ALL_DONE', depends_on: [{ task_key: 'A' }] }
  ];
  assert.strictEqual(_sentinelKeys(dag)['REPORTE'], undefined);
});
test('SK5: el centinela por NOMBRE sigue detectandose aunque no sea hoja ALL_DONE', function() {
  assert.strictEqual(_sentinelKeys([{ task_key: 'CENTINELA_FALLAS_DAG', depends_on: [] }])['CENTINELA_FALLAS_DAG'], true);
});
test('SK6: input invalido -> objeto vacio, no explota', function() {
  assert.deepStrictEqual(_sentinelKeys(null), {});
  assert.deepStrictEqual(_sentinelKeys([{}]), {});
});
test('SK7: _sortFailedTasks con el DAG despriorza WRAP_UP_CHECK', function() {
  var r = _sortFailedTasks([{ task_key: 'WRAP_UP_CHECK' }, { task_key: 'OLA_2' }], DAG_DIRECTOR);
  assert.strictEqual(r[0].task_key, 'OLA_2');
  assert.strictEqual(r[0].is_sentinel, false);
  assert.strictEqual(r[1].task_key, 'WRAP_UP_CHECK');
  assert.strictEqual(r[1].is_sentinel, true);
});
test('SK8: sin el DAG el comportamiento viejo se preserva', function() {
  assert.strictEqual(_sortFailedTasks([{ task_key: 'WRAP_UP_CHECK' }])[0].is_sentinel, false);
});
test('SK9: si el centinela estructural es la UNICA falla, NO se despriorza', function() {
  var r = _sortFailedTasks([{ task_key: 'WRAP_UP_CHECK' }], DAG_DIRECTOR);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].is_sentinel, false);
});

console.log('\n_childRunId');
test('CH1: extrae el run_id del hijo de runs/get-output', function() {
  assert.strictEqual(_childRunId({ run_job_output: { run_id: 912345678901235 } }), 912345678901235);
});
test('CH2: en runs/get run_job_output viene null -> null (no es ahi donde vive)', function() {
  assert.strictEqual(_childRunId({ run_job_output: null }), null);
  assert.strictEqual(_childRunId({}), null);
  assert.strictEqual(_childRunId(null), null);
});
test('CH3: run_id ausente, 0 o no numerico -> null; nunca navegar a un run falso', function() {
  assert.strictEqual(_childRunId({ run_job_output: {} }), null);
  assert.strictEqual(_childRunId({ run_job_output: { run_id: 0 } }), null);
  assert.strictEqual(_childRunId({ run_job_output: { run_id: '123' } }), null);
});

console.log('\n_mergeJobParams');
test('JQ1: un director sin notebook_task expone settings.parameters', function() {
  var s = { parameters: [{ name: 'fecha', 'default': '2026-09-07' }, { name: 'modo', 'default': 'full' }],
            tasks: [{ task_key: 'OLA_1', run_job_task: { job_id: 1 } }] };
  assert.deepStrictEqual(_mergeJobParams(s), { fecha: '2026-09-07', modo: 'full' });
});
test('JQ2: base_parameters de la task pisa el default del job', function() {
  var s = { parameters: [{ name: 'fecha', 'default': 'del_job' }],
            tasks: [{ notebook_task: { base_parameters: { fecha: 'de_la_task' } } }] };
  assert.strictEqual(_mergeJobParams(s).fecha, 'de_la_task');
});
test('JQ3: parametro sin default -> string vacio, no undefined', function() {
  assert.deepStrictEqual(_mergeJobParams({ parameters: [{ name: 'x' }] }), { x: '' });
});
test('JQ4: settings nulo o vacio -> {}', function() {
  assert.deepStrictEqual(_mergeJobParams(null), {});
  assert.deepStrictEqual(_mergeJobParams({}), {});
});

console.log('\n_countsAreSubjobs');
test('CS1: todas run_job -> true (es un director)', function() {
  assert.strictEqual(_countsAreSubjobs(DAG_DIRECTOR.slice(0, 3)), true);
});
test('CS2: el director con su centinela notebook -> false (no son TODAS)', function() {
  assert.strictEqual(_countsAreSubjobs(DAG_DIRECTOR), false);
});
test('CS3: lista vacia o invalida -> false', function() {
  assert.strictEqual(_countsAreSubjobs([]), false);
  assert.strictEqual(_countsAreSubjobs(null), false);
});

test('SN4: si el centinela es la UNICA falla, rompio de verdad -> NO se despriorza', function() {
  var r = _sortFailedTasks([{ task_key: 'CENTINELA_FALLAS_DAG' }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].is_sentinel, false);
});
test('PF5: el primary de un run del orquestador es la falla real, no el centinela', function() {
  // Reproduce un run real de un DAG grande: el centinela aparece primero en el array
  // y con reintentos duplicados; la falla real llega despues (pagina 2).
  var run = { tasks: [
    { task_key: 'CENTINELA_FALLAS_DAG', run_id: 1, state: { result_state: 'FAILED' }, notebook_task: { notebook_path: '/nb/sentinel' } },
    { task_key: 'CENTINELA_FALLAS_DAG', run_id: 2, state: { result_state: 'FAILED' }, notebook_task: { notebook_path: '/nb/sentinel' } },
    { task_key: 'daily_load',        run_id: 3, state: { result_state: 'FAILED' }, notebook_task: { notebook_path: '/nb/daily' } },
    { task_key: 'genera_informe_diario', run_id: 4, state: { result_state: 'FAILED' }, notebook_task: { notebook_path: '/nb/report' } }
  ]};
  var r = _parseFailedTasks(run);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].task_key, 'daily_load');
  assert.strictEqual(r[0].is_sentinel, false);
  assert.strictEqual(r[2].task_key, 'CENTINELA_FALLAS_DAG');
  assert.strictEqual(r[2].is_sentinel, true);
  assert.strictEqual(r[2].task_run_id, 2);
});

console.log('\n_dedupTasksByKey');
test('DD1: con repairs la misma task_key colapsa al ultimo intento', function() {
  var r = _dedupTasksByKey([
    { task_key: 'a', state: { result_state: 'FAILED'  } },
    { task_key: 'b', state: { result_state: 'SUCCESS' } },
    { task_key: 'a', state: { result_state: 'SUCCESS' } }
  ]);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map(function(t){return t.task_key;}), ['a','b']);
  assert.strictEqual(r[0].state.result_state, 'SUCCESS');
});
test('DD2: sin duplicados devuelve lo mismo, en orden', function() {
  var r = _dedupTasksByKey([{ task_key: 'x' }, { task_key: 'y' }]);
  assert.deepStrictEqual(r.map(function(t){return t.task_key;}), ['x','y']);
});
test('DD3: input invalido -> array vacio', function() {
  assert.deepStrictEqual(_dedupTasksByKey(null), []);
  assert.deepStrictEqual(_dedupTasksByKey(undefined), []);
});
test('DD4: entradas sin task_key se ignoran', function() {
  assert.strictEqual(_dedupTasksByKey([{}, null, { task_key: 'z' }]).length, 1);
});

// ──────────────────────────────────────────────────────────────────────────
// _findTaskInRun -- regresion del 2026-09-06.
// `pensarFix` leia runs/get SIN paginar. En un orquestador grande (>100 tasks) la task
// que fallaba de verdad caia en la pagina 2 y quedaba invisible; lo unico que traia la
// pagina 1 era el centinela. Resultado: notebookPath=null, el LLM diagnosticaba sin el
// codigo y el find->replace propuesto no matcheaba nunca contra el notebook real.
function _findTaskInRun(runDetail, taskKey) {
  if (!runDetail || !Array.isArray(runDetail.tasks)) return null;
  var tasks = _dedupTasksByKey(runDetail.tasks);
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i] && tasks[i].task_key === taskKey) return tasks[i];
  }
  return null;
}

console.log('\n_findTaskInRun');
test('FT1: la task de la pagina 2 aparece si las paginas se mergearon', function() {
  var pag1 = { run_id: 1, tasks: [{ task_key: 'CENTINELA', run_id: 10 }], next_page_token: 'tok' };
  var pag2 = { tasks: [{ task_key: 'daily_load', run_id: 20,
                         notebook_task: { notebook_path: '/nb/daily_load' } }] };
  var t = _findTaskInRun(_mergeRunPages([pag1, pag2]), 'daily_load');
  assert.ok(t, 'la task de la pagina 2 tiene que aparecer');
  assert.strictEqual(t.run_id, 20);
  assert.strictEqual(t.notebook_task.notebook_path, '/nb/daily_load');
});
test('FT2: leyendo SOLO la pagina 1 no se encuentra -- el bug original', function() {
  var pag1 = { run_id: 1, tasks: [{ task_key: 'CENTINELA', run_id: 10 }], next_page_token: 'tok' };
  assert.strictEqual(_findTaskInRun(pag1, 'daily_load'), null);
});
test('FT3: con retries devuelve el ULTIMO intento, no el primero', function() {
  var run = { tasks: [
    { task_key: 'daily_load', run_id: 20, attempt_number: 0 },
    { task_key: 'daily_load', run_id: 21, attempt_number: 1 },
    { task_key: 'daily_load', run_id: 22, attempt_number: 2 }
  ]};
  assert.strictEqual(_findTaskInRun(run, 'daily_load').run_id, 22);
});
test('FT4: task inexistente -> null (distinto de \"existe pero sin notebook\")', function() {
  assert.strictEqual(_findTaskInRun({ tasks: [{ task_key: 'otra', run_id: 1 }] }, 'NO_EXISTE'), null);
});
test('FT5: task sin notebook_task se encuentra igual (run_job_task)', function() {
  var t = _findTaskInRun({ tasks: [{ task_key: 'sub', run_id: 5, run_job_task: { job_id: 9 } }] }, 'sub');
  assert.ok(t);
  assert.strictEqual(t.notebook_task, undefined);
});
test('FT6: runDetail nulo o sin tasks -> null, no explota', function() {
  assert.strictEqual(_findTaskInRun(null, 'x'), null);
  assert.strictEqual(_findTaskInRun({}, 'x'), null);
});

// ──────────────────────────────────────────────────────────────────────────
// _mergeJobPages / getJobParams -- misma familia que runs/get.
// jobs/get 2.1 tira 400 con >100 tasks (lo tragaba un catch => editor de parametros
// vacio) y 2.2 corta settings.tasks a 100. Los campos top-level de settings (name,
// parameters, job_clusters) SOLO vienen en la pagina 1.
function _mergeJobPages(pages) {
  if (!pages || !pages.length || !pages[0]) return null;
  var base  = pages[0];
  var tasks = [];
  for (var i = 0; i < pages.length; i++) {
    var st = pages[i] && pages[i].settings;
    if (st && Array.isArray(st.tasks)) tasks = tasks.concat(st.tasks);
  }
  var merged = {};
  for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) merged[k] = base[k];
  merged.settings = {};
  if (base.settings) {
    for (var k2 in base.settings) {
      if (Object.prototype.hasOwnProperty.call(base.settings, k2)) merged.settings[k2] = base.settings[k2];
    }
  }
  merged.settings.tasks = tasks;
  delete merged.next_page_token;
  return merged;
}

function _mergeParams(jd) {
  var tasks = (jd && jd.settings && jd.settings.tasks) || [];
  var merged = {};
  for (var i = 0; i < tasks.length; i++) {
    var bp = tasks[i].notebook_task && tasks[i].notebook_task.base_parameters;
    if (bp) { for (var k in bp) { if (bp.hasOwnProperty(k)) merged[k] = bp[k]; } }
  }
  return merged;
}

console.log('\n_mergeJobPages');
var _jp1 = { job_id: 7, next_page_token: 'tok', settings: { name: 'Orq', parameters: [{ name: 'fecha' }],
             job_clusters: [{ job_cluster_key: 'c1' }],
             tasks: [{ task_key: 'a', notebook_task: { base_parameters: { fecha: '2026-01-01' } } }] } };
var _jp2 = { job_id: 7, settings: { name: 'Orq',
             tasks: [{ task_key: 'b', notebook_task: { base_parameters: { modo: 'full' } } }] } };
test('JP1: acumula settings.tasks de todas las paginas', function() {
  var m = _mergeJobPages([_jp1, _jp2]);
  assert.deepStrictEqual(m.settings.tasks.map(function(t){return t.task_key;}), ['a','b']);
});
test('JP2: conserva los campos que SOLO vienen en la pagina 1', function() {
  var m = _mergeJobPages([_jp1, _jp2]);
  assert.strictEqual(m.settings.parameters.length, 1);
  assert.strictEqual(m.settings.job_clusters.length, 1);
  assert.strictEqual(m.settings.name, 'Orq');
});
test('JP3: dropea next_page_token', function() {
  assert.strictEqual(_mergeJobPages([_jp1, _jp2]).next_page_token, undefined);
});
test('JP4: no muta la pagina 1 (settings se copia, no se referencia)', function() {
  _mergeJobPages([_jp1, _jp2]);
  assert.strictEqual(_jp1.settings.tasks.length, 1, 'la pagina 1 quedo mutada');
});
test('JP5: sin paginas -> null; pagina sin settings no rompe', function() {
  assert.strictEqual(_mergeJobPages([]), null);
  assert.deepStrictEqual(_mergeJobPages([{ job_id: 1 }]).settings.tasks, []);
});
test('JP6: getJobParams ve los base_parameters de la pagina 2 -- el bug', function() {
  assert.deepStrictEqual(_mergeParams(_jp1), { fecha: '2026-01-01' });
  assert.deepStrictEqual(_mergeParams(_mergeJobPages([_jp1, _jp2])),
                         { fecha: '2026-01-01', modo: 'full' });
});

// ──────────────────────────────────────────────────────────────────────────
// _selectRelevantCode -- el recorte del notebook que viaja al LLM.
// Antes se mandaban "los primeros N chars", la peor heuristica posible: el error casi
// nunca esta al principio. Caso medido: notebook de 20.997 chars, celda culpable en el
// char 10.308, corte en 10.000 => quedaba afuera por 308 caracteres y el LLM inventaba.
// Bloque copiado de apps_script/codigo.gs (mismo codigo que se deploya).
var _ANCHOR_STOP_ = (
  'traceback most recent call last file line module self none true false import from ' +
  'return raise print except try else elif with class def lambda global nonlocal ' +
  'error exception valueerror typeerror keyerror nameerror attributeerror indexerror ' +
  'analysisexception py4jjavaerror runtimeerror assertionerror ' +
  'python site packages databricks spark pyspark local usr lib ipython shell command ' +
  'json string object array none null true false var function ' +
  'sql dataframe select where group order count show display'
).split(' ');

function _isStopAnchor(w) {
  for (var i = 0; i < _ANCHOR_STOP_.length; i++) if (_ANCHOR_STOP_[i] === w) return true;
  return false;
}

// Identificadores del traceback que sirven para localizar la celda culpable. Se busca
// senal, no vocabulario: lo generico de un traceback y lo omnipresente en un notebook
// PySpark ('spark', 'select') no distingue una celda de otra y solo mete ruido.
function _errorAnchors(errorTrace) {
  // Los tracebacks de Databricks vienen con color ANSI: sin limpiarlo, la 'm' que
  // cierra cada codigo queda pegada al identificador y 'roster' entra dos veces, como
  // 'roster' y como 'mroster'. Anclas duplicadas = ruido que corre a las buenas.
  var limpio = String(errorTrace || '').replace(/\[[0-9;]*[A-Za-z]/g, ' ');
  var raw = limpio.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || [];
  var seen = {}, out = [];
  for (var i = 0; i < raw.length; i++) {
    var w = raw[i], lw = w.toLowerCase();
    if (_isStopAnchor(lw)) continue;
    if (Object.prototype.hasOwnProperty.call(seen, w)) continue;
    seen[w] = 1; out.push(w);
  }
  return out;
}

function _splitNotebookCells(source) {
  var txt = String(source || '');
  var re  = /\n#\s*COMMAND\s*-{2,}[^\n]*\n/g;
  var cells = [], last = 0, m;
  while ((m = re.exec(txt)) !== null) {
    cells.push({ text: txt.substring(last, m.index), sep: m[0] });
    last = m.index + m[0].length;
  }
  cells.push({ text: txt.substring(last), sep: '' });
  for (var i = 0; i < cells.length; i++) cells[i].index = i;
  return cells;
}

function _occurrences(hay, needle) {
  var n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// Puntaje por celda: cuantas anclas DISTINTAS contiene, cada una ponderada por su rareza
// (una que aparece en casi todas las celdas no distingue nada). Es un tf-idf de bolsillo.
function _scoreCells(cells, anchors) {
  var docFreq = {};
  for (var a = 0; a < anchors.length; a++) {
    var n = 0;
    for (var c = 0; c < cells.length; c++) if (cells[c].text.indexOf(anchors[a]) !== -1) n++;
    docFreq[anchors[a]] = n;
  }
  for (var c2 = 0; c2 < cells.length; c2++) {
    var s = 0, hits = [];
    for (var a2 = 0; a2 < anchors.length; a2++) {
      var an = anchors[a2], df = docFreq[an];
      if (df === 0 || df === cells.length) continue;
      if (cells[c2].text.indexOf(an) === -1) continue;
      s += (1 / df) * Math.min(_occurrences(cells[c2].text, an), 3);
      hits.push(an);
    }
    cells[c2].score = s;
    cells[c2].hits  = hits;
  }
  return cells;
}

var _OMITIDO_ = '\n\n#  [ ... %N% celdas del notebook omitidas por brevedad ... ]\n\n';

// Si una celda sola no entra en el presupuesto, se recorta por LINEAS alrededor de la
// que concentra mas anclas — no por el principio, que es justamente el bug que esto viene
// a arreglar.
function _cropCell(text, anchors, budget) {
  if (text.length <= budget) return text;
  var lines = text.split('\n');
  var best = 0, bestScore = -1;
  for (var i = 0; i < lines.length; i++) {
    var s = 0;
    for (var a = 0; a < anchors.length; a++) if (lines[i].indexOf(anchors[a]) !== -1) s++;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  var out = lines[best], lo = best, hi = best;
  while (out.length < budget && (lo > 0 || hi < lines.length - 1)) {
    if (lo > 0)                { lo--; if (out.length + lines[lo].length + 1 > budget) { lo++; break; } out = lines[lo] + '\n' + out; }
    if (hi < lines.length - 1) { hi++; if (out.length + lines[hi].length + 1 > budget) { hi--; break; } out = out + '\n' + lines[hi]; }
    if (lo === 0 && hi === lines.length - 1) break;
  }
  return out;
}

// Devuelve el extracto del notebook que de verdad importa para el error, dentro del
// presupuesto. Las celdas elegidas van VERBATIM (el LLM tiene que poder copiar el `find`
// caracter por caracter) y en su orden original; los huecos se marcan explicitamente.
function _selectRelevantCode(source, errorTrace, budget) {
  var txt = String(source || '');
  budget  = budget || 8000;
  if (!txt) return '';
  if (txt.length <= budget) return txt;

  var cells   = _splitNotebookCells(txt);
  var anchors = _errorAnchors(errorTrace);
  if (!anchors.length || cells.length < 2) return txt.substring(0, budget);
  _scoreCells(cells, anchors);

  var ranked = cells.slice().sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  var chosen = {}, used = 0;
  for (var i = 0; i < ranked.length; i++) {
    var c = ranked[i];
    if (c.score <= 0) break;
    var cost = c.text.length + 2;
    if (used + cost > budget) {
      // la primera que no entra, si es la mas relevante de todas, entra recortada
      if (!used) { chosen[c.index] = _cropCell(c.text, anchors, budget); used = budget; }
      continue;
    }
    chosen[c.index] = c.text;
    used += cost;
  }
  if (!used) return txt.substring(0, budget);

  // Los marcadores de hueco tambien ocupan lugar: se ensambla y, si el resultado se pasa,
  // se suelta la celda de menor score y se vuelve a armar. Devolver mas de lo pedido haria
  // que el prompt se corte por el otro lado y volveriamos al problema original.
  var orden = ranked.filter(function(c) {
    return Object.prototype.hasOwnProperty.call(chosen, c.index);
  });
  for (var guard = 0; guard < cells.length + 1; guard++) {
    var texto = _ensamblar(cells, chosen);
    if (texto.length <= budget) return texto;
    if (orden.length <= 1) {
      // Queda una sola celda y con los marcadores igual se pasa: los marcadores se
      // sacrifican antes que el codigo. Devolver de mas hace que el prompt se corte por
      // el otro lado, que es el problema que esto vino a resolver.
      var unica = chosen[orden[0].index];
      return unica.length <= budget ? unica : _cropCell(unica, anchors, budget);
    }
    var peor = orden.pop();
    delete chosen[peor.index];
  }
  return _ensamblar(cells, chosen);
}

function _ensamblar(cells, chosen) {
  var out = [], gap = 0;
  for (var j = 0; j < cells.length; j++) {
    if (Object.prototype.hasOwnProperty.call(chosen, j)) {
      if (gap) { out.push(_OMITIDO_.replace('%N%', String(gap))); gap = 0; }
      out.push(chosen[j]);
      // Si la de al lado tambien entro, va el separador ORIGINAL entre las dos. Sin esto
      // dos celdas contiguas quedan pegadas sin su "# COMMAND ----------" y el texto
      // resultante NO existe verbatim en el notebook => el `find` que copie el LLM de ahi
      // no matchea nunca, que es exactamente el sintoma que esto vino a arreglar.
      if (j + 1 < cells.length && Object.prototype.hasOwnProperty.call(chosen, j + 1)) {
        out.push(cells[j].sep);
      }
    } else gap++;
  }
  if (gap) out.push(_OMITIDO_.replace('%N%', String(gap)));
  return out.join('');
}

console.log('\n_errorAnchors / _selectRelevantCode');
test('AN1: limpia el color ANSI del traceback de Databricks', function() {
  var t = '\u001b[38;5;241m' + 'roster' + '\u001b[39m = leer_roster()';
  var a = _errorAnchors(t);
  assert.ok(a.indexOf('roster') !== -1, 'roster tiene que estar');
  assert.strictEqual(a.indexOf('mroster'), -1, 'no puede quedar la m del codigo ANSI');
});
test('AN2: descarta el vocabulario generico de traceback y PySpark', function() {
  var a = _errorAnchors('Traceback most recent call last File line module spark select mi_tabla_rara');
  assert.deepStrictEqual(a, ['mi_tabla_rara']);
});
test('SC1: parte el notebook por el separador de celdas de Databricks', function() {
  var nb = 'a = 1\n# COMMAND ----------\nb = 2\n# COMMAND ----------\nc = 3';
  assert.strictEqual(_splitNotebookCells(nb).length, 3);
});
test('SC2: EL BUG -- agarra la celda del error aunque este al final', function() {
  var relleno = [];
  for (var i = 0; i < 40; i++) relleno.push('x_' + i + ' = ' + i + ' # relleno sin relacion');
  var nb = relleno.join('\n# COMMAND ----------\n') +
           '\n# COMMAND ----------\n' + 'raise ValueError(chequear_barrera(roster_layout))';
  var trace = 'ValueError: chequear_barrera fallo sobre roster_layout';
  var out   = _selectRelevantCode(nb, trace, 300);
  assert.ok(out.indexOf('chequear_barrera(roster_layout)') !== -1,
            'la celda culpable tiene que entrar');
  assert.ok(nb.substring(0, 300).indexOf('chequear_barrera') === -1,
            'control: el recorte viejo NO la agarraba');
});
test('SC3: respeta el presupuesto, marcadores de hueco incluidos', function() {
  var celdas = [];
  for (var i = 0; i < 30; i++) celdas.push('bloque_' + i + ' = calcular(' + i + ')');
  celdas.push('romper(tabla_inexistente_xyz)');
  var nb = celdas.join('\n# COMMAND ----------\n');
  for (var b = 120; b <= 600; b += 120) {
    var out = _selectRelevantCode(nb, 'tabla_inexistente_xyz not found', b);
    assert.ok(out.length <= b, 'budget ' + b + ' excedido: ' + out.length);
  }
});
test('SC4: el codigo elegido va VERBATIM (el find tiene que matchear)', function() {
  var celda = "df = spark.table('mi_schema.tabla_rota')\n    .filter(col_x > 3)";
  var nb = 'setup = 1\n# COMMAND ----------\n' + celda + '\n# COMMAND ----------\nfin = 2';
  var out = _selectRelevantCode(nb, 'tabla_rota not found', 90);
  assert.ok(out.indexOf(celda) !== -1, 'la celda tiene que aparecer caracter por caracter');
});
test('SC5: si entra entero no se recorta ni se marca nada', function() {
  var nb = 'a = 1\n# COMMAND ----------\nb = 2';
  assert.strictEqual(_selectRelevantCode(nb, 'algo', 9000), nb);
});
test('SC6: sin anclas utiles cae al recorte viejo, no rompe', function() {
  var nb = 'a = 1\n# COMMAND ----------\nb = 2';
  var out = _selectRelevantCode(nb, 'Traceback most recent call last', 10);
  assert.strictEqual(out.length, 10);
});
test('SC7: entrada vacia o nula no explota', function() {
  assert.strictEqual(_selectRelevantCode('', 'x', 100), '');
  assert.strictEqual(_selectRelevantCode(null, null, 100), '');
});
test('SC8: INVARIANTE -- cada porcion mostrada existe VERBATIM en el notebook', function() {
  // Lo que atrapo el bug real: dos celdas contiguas elegidas se pegaban SIN su
  // '# COMMAND ----------' del medio, y ese texto no existe en el notebook => un find
  // copiado de ahi no matchea nunca.
  var celdas = [];
  for (var i = 0; i < 12; i++) celdas.push('relleno_' + i + ' = ' + i);
  celdas[3] = 'df = leer(tabla_zzz)';
  celdas[4] = 'df2 = filtrar(tabla_zzz)';   // adyacente a la anterior: el caso del bug
  celdas[9] = 'escribir(tabla_zzz, df2)';
  var nb  = celdas.join('\n# COMMAND ----------\n');
  var out = _selectRelevantCode(nb, 'tabla_zzz not found', 200);
  var partes = out.split(/\n\n#  \[[^\]]*\]\n\n/);
  var rotas  = partes.filter(function(t) { return t.length && nb.indexOf(t) === -1; });
  assert.strictEqual(rotas.length, 0, 'hay porciones que no existen verbatim en el notebook');
  assert.ok(partes.length > 1, 'el caso tiene que haber recortado algo');
  assert.ok(out.indexOf('df = leer(tabla_zzz)') !== -1 && out.indexOf('df2 = filtrar(tabla_zzz)') !== -1,
            'las dos celdas adyacentes tienen que entrar juntas');
});
test('SC9: el budget se respeta en TODOS los tamanos, no solo los comodos', function() {
  // Con una sola celda elegida el ensamblador devolvia celda + 2 marcadores (62 chars
  // c/u) y se pasaba del presupuesto: 144 chars para un budget de 140.
  var celdas = [];
  for (var i = 0; i < 12; i++) celdas.push('relleno_' + i + ' = ' + i);
  celdas[3] = 'df = leer(tabla_zzz)';
  celdas[4] = 'df2 = filtrar(tabla_zzz)';
  celdas[9] = 'escribir(tabla_zzz, df2)';
  var nb = celdas.join('\n# COMMAND ----------\n');
  for (var b = 20; b <= 400; b += 5) {
    var out = _selectRelevantCode(nb, 'tabla_zzz not found', b);
    assert.ok(out.length <= b, 'budget ' + b + ' excedido: ' + out.length);
  }
});
test('CR1: una celda mas grande que el budget se recorta ALREDEDOR del ancla', function() {
  var lineas = [];
  for (var i = 0; i < 60; i++) lineas.push('linea_de_relleno_' + i + ' = ' + i);
  lineas[45] = 'resultado = leer(tabla_culpable_zzz)';
  var out = _cropCell(lineas.join('\n'), ['tabla_culpable_zzz'], 200);
  assert.ok(out.length <= 200);
  assert.ok(out.indexOf('tabla_culpable_zzz') !== -1, 'el ancla tiene que quedar dentro');
});

// ──────────────────────────────────────────────────────────────────────────
// _mergeJobListPages / _chunk -- jobs/list sin limit devuelve 20 jobs + has_more.
// getDashboard leia solo esa pagina: los jobs que no entraban desaparecian de la lista.
function _mergeJobListPages(pages) {
  var out = [], seen = {};
  for (var i = 0; i < (pages || []).length; i++) {
    var jobs = (pages[i] && pages[i].jobs) || [];
    for (var j = 0; j < jobs.length; j++) {
      var id = String(jobs[j].job_id);
      if (seen[id]) continue;
      seen[id] = true;
      out.push(jobs[j]);
    }
  }
  return out;
}

function _chunk(arr, n) {
  var out = [];
  for (var i = 0; i < (arr || []).length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

console.log('\n_mergeJobListPages / _chunk');
test('JL1: concatena los jobs de todas las paginas, en orden', function() {
  var p1 = { jobs: [{ job_id: 1201 }, { job_id: 1202 }], has_more: true, next_page_token: 't' };
  var p2 = { jobs: [{ job_id: 1203 }], has_more: false };
  assert.deepStrictEqual(_mergeJobListPages([p1, p2]).map(function(j){return j.job_id;}),
    [1201, 1202, 1203]);
});
test('JL2: dedup por job_id (un job creado/borrado entre paginas puede repetirse)', function() {
  var p1 = { jobs: [{ job_id: 1, settings: { name: 'A' } }] };
  var p2 = { jobs: [{ job_id: '1', settings: { name: 'A' } }, { job_id: 2 }] };
  assert.strictEqual(_mergeJobListPages([p1, p2]).length, 2);
});
test('JL3: workspace sin jobs (sin clave jobs) / sin paginas -> []', function() {
  assert.deepStrictEqual(_mergeJobListPages([{ has_more: false }]), []);
  assert.deepStrictEqual(_mergeJobListPages([]), []);
  assert.deepStrictEqual(_mergeJobListPages(null), []);
});
test('CH1: _chunk parte en lotes y el ultimo puede ser mas corto', function() {
  var ids = []; for (var i = 0; i < 45; i++) ids.push(i);
  var c = _chunk(ids, 20);
  assert.deepStrictEqual(c.map(function(b){return b.length;}), [20, 20, 5]);
  assert.deepStrictEqual([].concat.apply([], c), ids, 'el orden tiene que conservarse (los dots se mapean por indice)');
});
test('CH2: _chunk de vacio / null -> []', function() {
  assert.deepStrictEqual(_chunk([], 20), []);
  assert.deepStrictEqual(_chunk(null, 20), []);
});

// Helpers puros que viven DUPLICADOS aca y en codigo.gs. El guard de abajo compara
// los cuerpos normalizando comentarios y espacios: lo que bloquea es drift de LOGICA.
// Agregar un helper compartido nuevo obliga a agregarlo aca -- a proposito.
var SYNC_GUARDED = [
  '_buildHintBlock', '_buildRunNowPayload', '_buildCancelPayload', '_buildRepairPayload',
  '_childRunId', '_chunk', '_countsAreSubjobs', '_mergeJobListPages', '_cropCell', '_dedupTasksByKey', '_ensamblar',
  '_errorAnchors', '_extractTaskMeta', '_findTaskInRun', '_isConfigComplete',
  '_isSentinelTask', '_isStopAnchor', '_mergeJobPages', '_mergeJobParams', '_mergeRunPages',
  '_normHost', '_oauthServiceName', '_stripClientSecret', '_sanitizeForRequireOAuth', '_parseConfig',
  '_occurrences', '_parseFailedTasks', '_parseFavorites', '_parseMultiConfig',
  '_parseRunHistory', '_parseServingEndpoints', '_runPageUrl', '_scoreCells',
  '_selectRelevantCode', '_sentinelKeys', '_sortFailedTasks', '_splitNotebookCells',
  '_toggleFavoriteLogic'
];

// Drift PREEXISTENTE, detectado el 2026-09-07 al generalizar el guard. Estos tests estan
// certificando una version vieja de la funcion: la de produccion hace otra cosa.
// Se dejan anotados en vez de arreglarlos a mano de apuro -- lo importante es que la lista
// no CREZCA. El test de abajo falla si aparece un drift nuevo, y tambien si uno de estos
// se arregla y queda de mas en la lista.
var SYNC_KNOWN_DRIFT = {
  '_appendFixLog':     'prod tiene la guarda de 8500 bytes de UserProperties (v67); la copia no',
  '_buildFixLogEntry': 'prod guarda find/replace cap 800 (v67); la copia guarda *_preview cap 80',
  '_buildLlmPayload':  'prod es bilingue (lang, max_tokens 1024); la copia es monolingue 512 + temperature 0',
  '_parseLlmResponse': 'const/includes vs var/indexOf'
};

function _syncBody(txt, name) {
  var unaLinea = new RegExp('^function ' + name + '\\([^\\n]*\\{[^\\n]*\\}[ \\t]*$', 'm');
  var m1 = txt.match(unaLinea);
  if (m1) return m1[0];
  var bloque = new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm');
  var m2 = txt.match(bloque);
  return m2 ? m2[0] : null;
}

function _syncNorm(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '')
          .replace(/\s+/g, ' ')
          .trim();
}

console.log('\nsincronia con codigo.gs');
test('SYNC2: ningun helper compartido drifteo de codigo.gs', function() {
  var fs   = require('fs');
  var path = require('path');
  var gs   = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'codigo.gs'), 'utf8');
  var mio  = fs.readFileSync(__filename, 'utf8');
  var nuevos = [], ausentes = [];
  for (var i = 0; i < SYNC_GUARDED.length; i++) {
    var n = SYNC_GUARDED[i];
    var a = _syncBody(gs, n), b = _syncBody(mio, n);
    if (!a || !b) { ausentes.push(n); continue; }
    if (_syncNorm(a) !== _syncNorm(b)) nuevos.push(n);
  }
  assert.deepStrictEqual(ausentes, [], 'no se pudo extraer: ' + ausentes.join(', '));
  assert.deepStrictEqual(nuevos, [], 'DRIFT: la copia inline quedo vieja en ' + nuevos.join(', '));
});
test('SYNC3: la lista de drift conocido no crecio ni quedo con sobrantes', function() {
  var fs   = require('fs');
  var path = require('path');
  var gs   = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'codigo.gs'), 'utf8');
  var mio  = fs.readFileSync(__filename, 'utf8');
  var siguen = [];
  for (var n in SYNC_KNOWN_DRIFT) {
    if (!Object.prototype.hasOwnProperty.call(SYNC_KNOWN_DRIFT, n)) continue;
    var a = _syncBody(gs, n), b = _syncBody(mio, n);
    if (a && b && _syncNorm(a) !== _syncNorm(b)) siguen.push(n);
  }
  // Si uno se arregla, sale de la lista: el test avisa para no dejar deuda fantasma.
  assert.deepStrictEqual(siguen.sort(), Object.keys(SYNC_KNOWN_DRIFT).sort(),
    'la lista de drift conocido no coincide con la realidad -- actualizala');
});

console.log('\nsincronia con codigo.gs');
test('SYNC: el bloque del selector copiado aca es identico al de codigo.gs', function() {
  // Las funciones se testean 'redefinidas inline'. Eso deja pasar drift: se arregla
  // codigo.gs, la copia de aca queda vieja y los tests certifican codigo muerto.
  var fs   = require('fs');
  var path = require('path');
  var gs   = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'codigo.gs'), 'utf8');
  var mio  = fs.readFileSync(__filename, 'utf8');
  var corte = function(txt, desde, hasta) {
    var a = txt.indexOf(desde);
    if (a === -1) return null;
    var b = txt.indexOf(hasta, a);   // DESPUES del inicio: 'console.log(' aparece antes tambien
    return (b === -1) ? null : txt.substring(a, b).replace(/\s+$/, '');
  };
  var enGs  = corte(gs,  'var _ANCHOR_STOP_', 'function _buildHintBlock');
  var enMio = corte(mio, 'var _ANCHOR_STOP_', 'console.log(');
  assert.ok(enGs && enMio, 'no se pudieron ubicar los bloques');
  assert.strictEqual(enMio, enGs, 'la copia inline quedo desincronizada de codigo.gs');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
