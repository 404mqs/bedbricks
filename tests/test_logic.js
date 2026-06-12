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
    { task_key: 'dl_transacciones',  state: { result_state: 'FAILED', state_message: 'AnalysisException: Table not found' } }
  ]};
  const r = _parseFailedTask(run);
  assert.strictEqual(r.task_key, 'dl_transacciones');
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
  const p = _buildRepairPayload(99999, 'dl_transacciones');
  assert.strictEqual(p.run_id, 99999);
  assert.deepStrictEqual(p.rerun_tasks, ['dl_transacciones']);
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
  var defaults = { host: '', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' };
  try {
    var c = JSON.parse(json || '{}');
    return {
      host:            String(c.host            || defaults.host),
      token:           String(c.token           || defaults.token),
      llm_endpoint:    String(c.llm_endpoint    || defaults.llm_endpoint),
      pinned_job_id:   String(c.pinned_job_id   || defaults.pinned_job_id),
      pinned_job_name: String(c.pinned_job_name || defaults.pinned_job_name)
    };
  } catch(e) { return defaults; }
}
function _isConfigComplete(config) {
  return !!(config.host && config.token);
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
      return { name: String((w && w.name) || ('Workspace ' + (i + 1))), host: n.host, token: n.token,
               llm_endpoint: n.llm_endpoint, pinned_job_id: n.pinned_job_id, pinned_job_name: n.pinned_job_name };
    });
  } else if (raw.host || raw.token) {
    var n = _parseConfig(json);
    workspaces = [{ name: 'Workspace 1', host: n.host, token: n.token, llm_endpoint: n.llm_endpoint,
                    pinned_job_id: n.pinned_job_id, pinned_job_name: n.pinned_job_name }];
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
test('_isConfigComplete: true when host and token present', function() {
  assert(_isConfigComplete({ host: 'https://adb.net', token: 'dapi', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' }) === true);
});
test('_isConfigComplete: false when token missing', function() {
  assert(_isConfigComplete({ host: 'https://adb.net', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' }) === false);
});
test('_isConfigComplete: false when host missing', function() {
  assert(_isConfigComplete({ host: '', token: 'dapi', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' }) === false);
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
function _parseFailedTasks(runData) {
  if (!runData || !Array.isArray(runData.tasks)) return [];
  var byKey = {};
  for (var i = 0; i < runData.tasks.length; i++) {
    var t = runData.tasks[i];
    if (t.state && t.state.result_state === 'FAILED') {
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
  return Object.keys(byKey).map(function(k) { return byKey[k]; });
}

console.log('\n_parseFailedTasks');
test('PF1: task run_job fallida captura subjob_id e is_subjob', function() {
  var run = { tasks: [
    { task_key: 'subjob_carga', state: { result_state: 'FAILED' }, run_job_task: { job_id: 870620035180392 } }
  ]};
  var r = _parseFailedTasks(run);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].is_subjob, true);
  assert.strictEqual(r[0].is_notebook, false);
  assert.strictEqual(r[0].subjob_id, 870620035180392);
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
    { task_key: 'dl_x', state: { result_state: 'FAILED' }, notebook_task: { notebook_path: '/old' } },
    { task_key: 'dl_x', state: { result_state: 'FAILED' }, run_job_task: { job_id: 123 } }
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
  var r = _globalSearch('orq', [{ name: 'Orquestador Diario', job_id: 1 }], []);
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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
