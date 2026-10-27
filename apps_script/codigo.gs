// Bedbricks — Backend
// All config is stored per-user in UserProperties under 'bedbricks_config'.

// Estructura multi-workspace en UserProperties 'bedbricks_config':
//   { active: <idx>, lang: 'es'|'en',
//     workspaces: [{name, host, auth: 'oauth'|'pat', client_id, token, llm_endpoint, pinned_job_id, pinned_job_name}] }
// _getConfig_() devuelve el workspace ACTIVO aplanado (+ lang global) para no tocar los call sites
// que usan cfg.host / cfg.llm_endpoint / cfg.pinned_job_id / cfg.lang.
function _getMulti_() {
  var props = PropertiesService.getUserProperties();
  var multi;
  try { multi = _parseMultiConfig(props.getProperty('bedbricks_config') || '{}'); }
  catch(e) { return { active: 0, lang: 'en', workspaces: [] }; }
  // REQUIRE_OAUTH: a PAT this user saved before is wiped on their next open (and PAT mode is refused).
  if (_requireOAuth_() && _sanitizeForRequireOAuth(multi)) props.setProperty('bedbricks_config', JSON.stringify(multi));
  return multi;
}

function _activeWorkspace(multi) {
  var ws = multi.workspaces[multi.active];
  if (!ws) return { name: '', host: '', auth: 'oauth', client_id: '', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' };
  return ws;
}

function _getConfig_() {
  var multi = _getMulti_();
  var ws    = _activeWorkspace(multi);
  return {
    host:            ws.host,
    auth:            _wsAuth_(ws),
    client_id:       ws.client_id,
    token:           ws.token,
    llm_endpoint:    ws.llm_endpoint,
    pinned_job_id:   ws.pinned_job_id,
    pinned_job_name: ws.pinned_job_name,
    lang:            multi.lang,
    workspace_name:  ws.name
  };
}

function _headers() {
  return { 'Authorization': _bearer_(_getConfig_()), 'Content-Type': 'application/json' };
}

// ── Auth: OAuth user-to-machine (PKCE, per user) or Personal Access Token ────
// OAuth uses a public Databricks OAuth app (no client secret) registered with the redirect URL
// https://script.google.com/macros/d/<SCRIPT_ID>/usercallback. Each user's tokens live in THEIR
// UserProperties (the web app executes as USER_ACCESSING); nothing is shared between users.
// Script Properties (optional, per deployment):
//   OAUTH_CLIENT_ID    — default client id for workspaces that do not set their own
//   REQUIRE_OAUTH      — 'true' refuses PAT mode and wipes saved PATs
//   OAUTH_REDIRECT_URI — overrides the callback URL. For Google Workspace domains use
//                        https://script.google.com/a/macros/<domain>/d/<SCRIPT_ID>/usercallback: the generic
//                        URL opens with the browser's DEFAULT Google account, so with several accounts signed in
//                        the callback fails with "Authorization is required" (register this URL in Databricks first)
function _requireOAuth_() {
  return String(PropertiesService.getScriptProperties().getProperty('REQUIRE_OAUTH') || '').toLowerCase() === 'true';
}

function _defaultClientId_() {
  return String(PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_ID') || '').trim();
}

function _wsAuth_(ws) {
  return (!_requireOAuth_() && ws && ws.auth === 'pat') ? 'pat' : 'oauth';
}

function _oauthService_(ws) {
  var host = _normHost(ws.host);
  var clientId = String(ws.client_id || '').trim() || _defaultClientId_();
  if (!host)     throw new Error('Host not configured — open Settings');
  if (!clientId) throw new Error('OAuth client id not configured — set it in the workspace or in the OAUTH_CLIENT_ID Script Property');
  var svc = OAuth2.createService(_oauthServiceName(host));
  var redirect = String(PropertiesService.getScriptProperties().getProperty('OAUTH_REDIRECT_URI') || '').trim();
  if (redirect) svc.setRedirectUri(redirect);
  return svc
    .setAuthorizationBaseUrl(host + '/oidc/v1/authorize')
    .setTokenUrl(host + '/oidc/v1/token')
    .setClientId(clientId)
    .setScope('all-apis offline_access')
    .generateCodeVerifier()                               // PKCE S256: the verifier travels in the state token
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setCache(CacheService.getUserCache())
    .setLock(LockService.getUserLock())                   // parallel refreshes would burn the refresh token
    .setTokenPayloadHandler(_stripClientSecret);          // the library always sends client_secret; a public client has none
}

// Bearer header value for a workspace. OAuth refreshes by itself; without access it throws NEEDS_AUTH
// (never authorized, or the refresh token expired after ~7 days unused) and the UI offers "Connect".
function _bearer_(ws) {
  if (_wsAuth_(ws) === 'pat') {
    if (!ws.token) throw new Error('Token not configured — open Settings');
    return 'Bearer ' + ws.token;
  }
  var svc = _oauthService_(ws);
  if (!svc.hasAccess()) throw new Error('NEEDS_AUTH: connect this workspace to Databricks (Settings → Connect)');
  return 'Bearer ' + svc.getAccessToken();
}

function _oauthConnected_(ws) {
  if (_wsAuth_(ws) !== 'oauth') return false;
  try { return _oauthService_(ws).hasAccess(); } catch (e) { return false; }
}

// URL the user opens to authorize this workspace (the frontend opens it in a new tab).
function getAuthUrl(index) {
  var multi = _getMulti_();
  var ws = multi.workspaces[index];
  if (!ws) throw new Error('Workspace not found');
  if (_webappRedirect_()) return _webappAuthUrl_(ws, index);
  return _oauthService_(ws).getAuthorizationUrl({ ws: String(index) });
}

// ── OAuth return through the web app itself (/exec) ─────────────────────────────
// On some Google Workspace domains /usercallback never runs the callback ("Authorization is required to
// perform that action", no execution logged), even for the owner with every scope granted. If
// OAUTH_REDIRECT_URI is the web app's /exec URL, Bedbricks does PKCE itself: the state and the verifier
// live in the user's UserProperties, doGet receives ?code&state, and the token is stored where the OAuth2
// library keeps it, so refresh and everything else stay the same.
var _PKCE_PREFIX = 'bedbricks_pkce_';
var _PKCE_TTL_MS = 10 * 60 * 1000;

function _webappRedirect_() {
  var r = String(PropertiesService.getScriptProperties().getProperty('OAUTH_REDIRECT_URI') || '').trim();
  return /\/exec$/.test(r) ? r : '';
}

function _b64url_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function _webappAuthUrl_(ws, index) {
  _oauthService_(ws);                                        // validates host and client id
  var host = _normHost(ws.host);
  var clientId = String(ws.client_id || '').trim() || _defaultClientId_();
  var state = _b64url_(Utilities.getUuid() + Utilities.getUuid()).slice(0, 48);
  var verifier = _b64url_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                                  Utilities.getUuid() + Utilities.getUuid() + Date.now()))
               + _b64url_(Utilities.getUuid());
  var challenge = _b64url_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, verifier,
                                                   Utilities.Charset.US_ASCII));
  PropertiesService.getUserProperties().setProperty(_PKCE_PREFIX + state, JSON.stringify({
    ws: index, host: host, verifier: verifier, exp: Date.now() + _PKCE_TTL_MS }));
  var q = { response_type: 'code', client_id: clientId, redirect_uri: _webappRedirect_(),
            scope: 'all-apis offline_access', state: state,
            code_challenge: challenge, code_challenge_method: 'S256' };
  return host + '/oidc/v1/authorize?' + Object.keys(q).map(function(k) {
    return k + '=' + encodeURIComponent(q[k]);
  }).join('&');
}

// Returns the page shown in the sign-in tab. Every failure ends in a readable message, never a throw.
function _webappAuthReturn_(p) {
  var ok = false, err = '';
  var props = PropertiesService.getUserProperties();
  try {
    if (p.error) throw new Error(p.error_description || p.error);
    var key = _PKCE_PREFIX + String(p.state || '').replace(/[^A-Za-z0-9_-]/g, '');
    var saved = JSON.parse(props.getProperty(key) || 'null');
    props.deleteProperty(key);                                // single use, also on failure
    if (!saved || saved.exp < Date.now()) throw new Error('Sign-in expired or not started here — press Connect again');
    var ws = _getMulti_().workspaces[saved.ws];
    if (!ws || _normHost(ws.host) !== saved.host) throw new Error('Workspace not found');
    var clientId = String(ws.client_id || '').trim() || _defaultClientId_();
    var resp = UrlFetchApp.fetch(saved.host + '/oidc/v1/token', {
      method: 'post', muteHttpExceptions: true,
      payload: { grant_type: 'authorization_code', code: p.code, client_id: clientId,
                 redirect_uri: _webappRedirect_(), code_verifier: saved.verifier },
    });
    var token = JSON.parse(resp.getContentText() || '{}');
    if (resp.getResponseCode() !== 200 || !token.access_token) {
      throw new Error('Token exchange failed (HTTP ' + resp.getResponseCode() + '): ' +
                      (token.error_description || token.error || resp.getContentText().slice(0, 200)));
    }
    token.granted_time = Math.floor(Date.now() / 1000);       // what the library uses to know when to refresh
    _oauthService_(ws).getStorage().setValue(null, token);    // same slot the library's handleCallback writes
    ok = true;
  } catch (e) { err = e.message; }
  // Housekeeping: drop abandoned sign-ins of this user.
  try {
    var all = props.getProperties();
    Object.keys(all).forEach(function(k) {
      if (k.indexOf(_PKCE_PREFIX) !== 0) return;
      try { if (JSON.parse(all[k]).exp < Date.now()) props.deleteProperty(k); } catch (e2) { props.deleteProperty(k); }
    });
  } catch (e3) {}
  var msg = ok ? '<h2>✓ Connected to Databricks</h2><p>You can close this tab and go back to Bedbricks.</p>'
               : '<h2>Authorization failed</h2><p>' + String(err || 'Access denied').replace(/</g, '&lt;') + '</p>';
  return HtmlService.createHtmlOutput('<body style="background:#0f0f0f;color:' + (ok ? '#e5e5e5' : '#f87171') +
    ';font-family:sans-serif;padding:40px;text-align:center">' + msg + '</body>').setTitle('Bedbricks');
}

function authCallback(request) {
  var ok = false, err = '';
  try {
    var ws = _getMulti_().workspaces[parseInt(request.parameter.ws, 10)];
    if (!ws) throw new Error('Workspace not found');
    ok = _oauthService_(ws).handleCallback(request);
  } catch (e) { err = e.message; }
  var msg = ok ? '<h2>✓ Connected to Databricks</h2><p>You can close this tab and go back to Bedbricks.</p>'
               : '<h2>Authorization failed</h2><p>' + String(err || 'Access denied').replace(/</g, '&lt;') + '</p>';
  return HtmlService.createHtmlOutput('<body style="background:#0f0f0f;color:' + (ok ? '#e5e5e5' : '#f87171') +
    ';font-family:sans-serif;padding:40px;text-align:center">' + msg + '</body>');
}

function disconnectWorkspace(index) {
  var ws = _getMulti_().workspaces[index];
  if (ws) { try { _oauthService_(ws).reset(); } catch (e) {} }
  return getWorkspaces();
}

function _dbxFetch(path, options) {
  var config = _getConfig_();
  if (!config.host) throw new Error('Host not configured — open Settings');
  options = options || {};
  options.headers            = _headers();
  options.muteHttpExceptions = true;
  var resp = UrlFetchApp.fetch(config.host + path, options);
  var code = resp.getResponseCode();
  var body = resp.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('DBX API error ' + code + ': ' + body.substring(0, 200));
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error('DBX API returned invalid JSON: ' + body.substring(0, 200));
  }
}

const SYSTEM_PROMPT_ =
  "Actuá como Principal Data Engineer experto en PySpark y Databricks. " +
  "Analizá el error y respondé SOLO con estos 3 bullets (1 línea cada uno, sin nada más):\n\n" +
  "• **Qué rompió:** <task + tipo de error en 1 línea>\n" +
  "• **Root cause:** <causa exacta en 1 línea>\n" +
  "• **Acción:** REPAIR | FIX DE CÓDIGO | INVESTIGAR — <qué hacer puntualmente>";

const SYSTEM_PROMPT_EN_ =
  "Act as a Principal Data Engineer expert in PySpark and Databricks. " +
  "Analyze the error and respond ONLY with these 3 bullets (1 line each, nothing else):\n\n" +
  "• **What broke:** <task + error type in 1 line>\n" +
  "• **Root cause:** <exact cause in 1 line>\n" +
  "• **Action:** REPAIR | CODE FIX | INVESTIGATE — <what to do>";

function _buildLlmPayload(errorMessage, lang) {
  return {
    messages: [
      { role: 'system', content: lang === 'en' ? SYSTEM_PROMPT_EN_ : SYSTEM_PROMPT_ },
      { role: 'user',   content: errorMessage   }
    ],
    max_tokens: 1024
  };
}

function _parseLlmResponse(responseBody) {
  try {
    var data    = JSON.parse(responseBody);
    var content = data.choices[0].message.content;
    if (!content) return { summary: '[Diagnóstico no disponible]', is_code_error: false };
    var lc          = content.toLowerCase();
    var is_code_error = lc.indexOf('fix de código') !== -1 || lc.indexOf('code fix') !== -1;
    return { summary: content, is_code_error: is_code_error };
  } catch (e) {
    return { summary: '[Diagnóstico no disponible — respuesta malformada]', is_code_error: false };
  }
}

// ── Paginación de runs/get ──────────────────────────────────────────────────
// /api/2.2/jobs/runs/get devuelve como MÁXIMO 100 tasks por página + next_page_token.
// Leer sólo la primera página trunca cualquier job grande: en un DAG de cientos de tasks
// las falladas que caen en la página 2 son invisibles y sólo se ve la task centinela
// (la última hoja del DAG), cuyo traceback no es la causa de nada.
var _MAX_RUN_PAGES_ = 20; // guarda anti-loop (2000 tasks)

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

// Con repairs la API devuelve la misma task_key varias veces (una por intento): un run
// grande con reintentos trae bastantes más entradas que tasks. Nos quedamos con el ÚLTIMO
// intento de cada una — el que refleja el estado final.
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

// Encuentra una task dentro de un run YA PAGINADO. Dos cosas que hay que hacer juntas o
// no sirve de nada: leer TODAS las paginas (una task de la 2 es invisible si se lee solo
// la 1) y quedarse con el ULTIMO intento (con retries la misma task_key viene N veces, y
// el primero trae el traceback del intento que fallo primero, no el del estado final).
// Devuelve null si la task no esta — que NO es lo mismo que "la task no tiene notebook".
function _findTaskInRun(runDetail, taskKey) {
  if (!runDetail || !Array.isArray(runDetail.tasks)) return null;
  var tasks = _dedupTasksByKey(runDetail.tasks);
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i] && tasks[i].task_key === taskKey) return tasks[i];
  }
  return null;
}

function _getRunDetailPaged(runId) {
  var pages = [], token = null;
  for (var i = 0; i < _MAX_RUN_PAGES_; i++) {
    var page = _dbxFetch(_runPageUrl(runId, token));
    pages.push(page);
    token = page && page.next_page_token;
    if (!token) break;
  }
  return _mergeRunPages(pages);
}

// ── Paginación de jobs/get ───────────────────────────────────────────────
// Mismo problema que runs/get y la misma solucion. Dos trampas distintas:
//   * la API **2.1** no degrada: devuelve 400 "Resources with more than 100 tasks can only
//     be handled by API 2.2" y un catch la convierte en "sin datos" en silencio;
//   * la **2.2** responde 200 pero `settings.tasks` viene cortado a 100 + next_page_token.
// Los campos top-level de `settings` (name, parameters, job_clusters) solo vienen en la
// pagina 1: de las siguientes se acumula unicamente `tasks`.
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

function _getJobDetailPaged(jobId) {
  var pages = [], token = null;
  for (var i = 0; i < _MAX_RUN_PAGES_; i++) {
    var page = _dbxFetch('/api/2.2/jobs/get?job_id=' + jobId +
                         (token ? '&page_token=' + encodeURIComponent(token) : ''));
    pages.push(page);
    token = page && page.next_page_token;
    if (!token) break;
  }
  return _mergeJobPages(pages);
}

// ── Task centinela ──────────────────────────────────────────────────────────
// Un centinela existe sólo para que el run cierre FAILED cuando alguna task de adentro
// falló (con run_if=ALL_DONE la falla se absorbe y el run cerraría SUCCESS_WITH_FAILURES,
// sin disparar ninguna alerta). Su traceback NO es la causa: diagnosticarla con el LLM
// quema una llamada y esconde la falla real.
// Substring, no lista exacta de nombres: la task se llama distinto en cada workspace.
function _isSentinelTask(task) {
  if (!task) return false;
  var key = String(task.task_key || '').toLowerCase();
  if (key.indexOf('centinela') !== -1 || key.indexOf('sentinel') !== -1) return true;
  var msg = String(task.state_message || '').toLowerCase();
  return msg.indexOf('centinela') !== -1 || msg.indexOf('sentinel task') !== -1;
}

// Los centinelas van AL FINAL: el primary (el diagnóstico de arriba y el target por defecto
// de Think Fix) tiene que ser la falla real. Orden relativo estable dentro de cada grupo.
// Excepción: si el centinela es la ÚNICA task fallada, entonces sí rompió de verdad
// (bug en el propio notebook centinela) → no se despriorza y se diagnostica normal.
// Deteccion ESTRUCTURAL, porque el nombre se pudre: un centinela es la HOJA del DAG que
// corre con run_if=ALL_DONE. El match por substring dejo de ver al centinela cuando se
// renombro a un nombre sin la palabra 'centinela', y en un job "director" (todas las tasks son run_job) eso es
// grave: las fallas run_job no se diagnostican, asi que el centinela quedaba siendo la UNICA
// task con diagnostico IA y Think Fix -- justo la que no es la causa. Es el bug de la v79
// entrando por la puerta del rename.
// Calibrado contra el DAG real: de sus 3 tasks ALL_DONE solo el centinela es hoja, y hojas
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

// El run_id del hijo NO esta en runs/get: ahi run_job_output viene null (medido). Sale de
// runs/get-output sobre el run_id de la TASK padre. Sin esto, el drill a un sub-job navega
// al ULTIMO run del job hijo, que puede ser de otro dia que el que fallo.
function _childRunId(outputPayload) {
  if (!outputPayload || !outputPayload.run_job_output) return null;
  var rid = outputPayload.run_job_output.run_id;
  return (typeof rid === 'number' && rid > 0) ? rid : null;
}

// Un run cuyas tasks son TODAS run_job es un director: la barra cuenta olas, no tasks,
// y rotularla "tasks" miente por dos ordenes de magnitud.
function _countsAreSubjobs(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return false;
  for (var i = 0; i < tasks.length; i++) {
    if (!tasks[i] || !tasks[i].run_job_task) return false;
  }
  return true;
}

function _parseFailedTasks(runData) {
  if (!runData || !Array.isArray(runData.tasks)) return [];
  // Cuando hay repairs, la API devuelve la misma task_key varias veces (una por intento).
  // Usamos un mapa para deduplicar, quedándonos con la última ocurrencia (más reciente).
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
  // El DAG completo va como contexto: sin el, la deteccion estructural del centinela
  // (hoja + ALL_DONE) no tiene con que decidir y solo queda el match por nombre.
  return _sortFailedTasks(order.map(function(k) { return byKey[k]; }), runData.tasks);
}

function _extractTaskMeta(task) {
  if (!task) return { task_type: 'other', notebook_path: null, notebook_params: null, subjob_id: null };
  if (task.notebook_task) return {
    task_type:       'notebook',
    notebook_path:   task.notebook_task.notebook_path   || null,
    notebook_params: task.notebook_task.base_parameters || null,
    subjob_id:       null
  };
  if (task.run_job_task) return {
    task_type:       'run_job',
    notebook_path:   null,
    notebook_params: null,
    subjob_id:       task.run_job_task.job_id || null
  };
  if (task.python_wheel_task) return { task_type: 'python_wheel', notebook_path: null, notebook_params: null, subjob_id: null };
  if (task.spark_python_task) return { task_type: 'spark_python', notebook_path: null, notebook_params: null, subjob_id: null };
  return { task_type: 'other', notebook_path: null, notebook_params: null, subjob_id: null };
}

function _getTaskErrorMessage(failedTask) {
  var msg = failedTask.state_message || '';
  if (!failedTask.task_run_id) return msg;
  try {
    var out = _dbxFetch('/api/2.1/jobs/runs/get-output?run_id=' + failedTask.task_run_id);
    var trace = out.error_trace || out.error || '';
    return trace || msg;
  } catch (e) {
    return msg;
  }
}


function analizarErrorConLLM(errorMessage, lang) {
  var cfg = _getConfig_();
  try {
    var payload  = _buildLlmPayload(errorMessage, lang);
    var resp     = UrlFetchApp.fetch(
      cfg.host + '/serving-endpoints/' + (cfg.llm_endpoint || 'databricks-meta-llama-3-1-70b-instruct') + '/invocations',
      {
        method:             'post',
        headers:            _headers(),
        payload:            JSON.stringify(payload),
        muteHttpExceptions: true
      }
    );
    if (resp.getResponseCode() !== 200) {
      return { summary: '[LLM — HTTP ' + resp.getResponseCode() + ']', is_code_error: false };
    }
    return _parseLlmResponse(resp.getContentText());
  } catch (e) {
    return { summary: '[' + (lang === 'en' ? 'Diagnosis unavailable' : 'Diagnóstico no disponible') + ' — ' + e.message + ']', is_code_error: false };
  }
}

function _buildRepairPayload(runId, taskKeys, latestRepairId) {
  // taskKeys puede venir como string (1 task) o como array (varias) desde el frontend.
  // Normalizamos a array plano: rerun_tasks espera array[string]. Envolver un array ya
  // existente producía [["task"]] → 400 MALFORMED_REQUEST (Expected Scalar value).
  var keys = Array.isArray(taskKeys) ? taskKeys : [taskKeys];
  var payload = {
    run_id:                runId,
    rerun_tasks:           keys,
    rerun_dependent_tasks: true   // re-corre también las tasks bloqueadas downstream → el DAG continúa
  };
  if (latestRepairId) payload.latest_repair_id = latestRepairId;
  return payload;
}

function repairRun(runId, taskKeys) {
  // repair_history NO viene en el response de runs/get en esta workspace, así que el
  // latest_repair_id (que Databricks exige a partir del 2do repair del mismo run) lo
  // persistimos por run en UserProperties tras cada repair exitoso.
  var prev = null;
  try { prev = PropertiesService.getUserProperties().getProperty('repair_' + runId); } catch (e) {}
  var payload = _buildRepairPayload(runId, taskKeys, prev);
  var result  = _dbxFetch('/api/2.1/jobs/runs/repair', {
    method:  'post',
    payload: JSON.stringify(payload)
  });
  try {
    if (result && result.repair_id) {
      PropertiesService.getUserProperties().setProperty('repair_' + runId, String(result.repair_id));
    }
  } catch (e) {}
  return result;
}

// ── Paginación de jobs/list ─────────────────────────────────────────────
// Sin `limit`, jobs/list devuelve 20 jobs + has_more/next_page_token. Una sola llamada
// dejaba afuera todo lo que no entraba en la página 1, y como la lista se ordena por
// nombre en el cliente, el corte no se notaba: faltaban jobs sin ningún aviso.
// `limit` acepta como máximo 100 (101 → 400 INVALID_PARAMETER_VALUE).
var _JOBS_LIST_LIMIT_     = 100;
var _MAX_JOB_LIST_PAGES_  = 20; // guarda anti-loop (2000 jobs)

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

function _listAllJobs() {
  var pages = [], token = null;
  for (var i = 0; i < _MAX_JOB_LIST_PAGES_; i++) {
    var page = _dbxFetch('/api/2.1/jobs/list?expand_tasks=false&limit=' + _JOBS_LIST_LIMIT_ +
                         (token ? '&page_token=' + encodeURIComponent(token) : ''));
    pages.push(page);
    token = page && page.next_page_token;
    if (!token) break;
  }
  return _mergeJobListPages(pages);
}

// Parte una lista en lotes de n (el último puede ser más corto).
function _chunk(arr, n) {
  var out = [];
  for (var i = 0; i < (arr || []).length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

var _DOTS_BATCH_ = 20;

// Últimos 5 runs POR job, en paralelo. La runs/list global no sirve para los dots:
// solo trae los runs más recientes del workspace (y topa en limit=25), así que un job
// que corre 1×/día aparece 1 sola vez → 1 puntito. Esto pide runs/list?job_id&limit=5
// por cada job y replica exactamente lo que muestra Databricks.
// Con jobs/list paginado pueden ser cientos de jobs: se piden en lotes de _DOTS_BATCH_
// (un fetchAll por lote) y los 429 se reintentan una sola vez; el resto de los errores
// deja ese job sin dots, como antes.
function _fetchJobsDots(jobIds) {
  if (!jobIds || !jobIds.length) return {};
  var config  = _getConfig_();
  var authHdr = { 'Authorization': _bearer_(config) };
  var reqFor = function(id) {
    return {
      url:                config.host + '/api/2.1/jobs/runs/list?job_id=' + id + '&limit=5&expand_tasks=false',
      headers:            authHdr,
      muteHttpExceptions: true
    };
  };
  var responses = [];
  _chunk(jobIds, _DOTS_BATCH_).forEach(function(batch) {
    var resps = UrlFetchApp.fetchAll(batch.map(reqFor));
    var retry = [];
    resps.forEach(function(r, k) { if (r.getResponseCode() === 429) retry.push(k); });
    if (retry.length) {
      Utilities.sleep(1000);
      var again = UrlFetchApp.fetchAll(retry.map(function(k) { return reqFor(batch[k]); }));
      retry.forEach(function(k, m) { resps[k] = again[m]; });
    }
    responses = responses.concat(resps);
  });
  var map = {};
  responses.forEach(function(resp, idx) {
    var id = String(jobIds[idx]);
    try {
      if (resp.getResponseCode() !== 200) { map[id] = []; return; }
      var d = JSON.parse(resp.getContentText());
      map[id] = (d.runs || []).slice(0, 5).map(function(r) {
        return {
          run_id:           r.run_id,
          result_state:     (r.state && r.state.result_state)     || '',
          life_cycle_state: (r.state && r.state.life_cycle_state) || ''
        };
      });
    } catch (e) { map[id] = []; }
  });
  return map;
}

function getDashboard() {
  var jobsArr  = _listAllJobs();
  var runsData = _dbxFetch('/api/2.1/jobs/runs/list?limit=25&expand_tasks=false');
  var runs = runsData.runs || [];

  var jobNames = {};
  jobsArr.forEach(function(j) {
    jobNames[String(j.job_id)] = (j.settings && j.settings.name) ? j.settings.name : String(j.job_id);
  });

  var dotsByJob = _fetchJobsDots(jobsArr.map(function(j) { return j.job_id; }));

  var jobs = jobsArr.map(function(j) {
    return {
      job_id:   j.job_id,
      name:     (j.settings && j.settings.name) ? j.settings.name : String(j.job_id),
      schedule: (j.settings && j.settings.schedule) ? 'Scheduled' : '',
      runs:     dotsByJob[String(j.job_id)] || []
    };
  }).sort(function(a, b) { return a.name.localeCompare(b.name); });

  var recentRuns = runs.map(function(r) {
    return {
      run_id:           r.run_id,
      job_id:           r.job_id,
      job_name:         jobNames[String(r.job_id)] || r.run_name || String(r.job_id),
      start_time:       r.start_time        || 0,
      duration_ms:      r.execution_duration || 0,
      life_cycle_state: (r.state && r.state.life_cycle_state) || '',
      result_state:     (r.state && r.state.result_state)     || ''
    };
  });

  return { jobs: jobs, runs: recentRuns };
}

function getJobDetail(jobId, lang) {
  var listData = _dbxFetch('/api/2.1/jobs/runs/list?job_id=' + jobId + '&limit=10');
  if (!listData.runs || listData.runs.length === 0) {
    return { status: 'NO_RUNS', job_id: jobId, run_history: [], run_history_with_tasks: [] };
  }
  return _detailForRun(listData.runs[0], jobId, lang, listData.runs, null);
}

// Detalle de UN run concreto, no del ultimo del job. Es el destino del drill a un sub-job:
// navegar por job_id te deja en el run mas reciente del hijo, que con un repair, una corrida
// manual, o simplemente al abrir un run viejo del historial, es OTRO run -- y nada en la
// pantalla lo dice.
function getRunDetail(runId, lang) {
  var runDetail = _getRunDetailPaged(runId);
  if (!runDetail || !runDetail.run_id) {
    return { status: 'NO_RUNS', job_id: null, run_history: [], run_history_with_tasks: [] };
  }
  var jobId = runDetail.job_id || null;
  var siblings = [];
  if (jobId) {
    try { siblings = _dbxFetch('/api/2.1/jobs/runs/list?job_id=' + jobId + '&limit=10').runs || []; }
    catch (e) {}
  }
  return _detailForRun(runDetail, jobId, lang, siblings, runDetail);
}

function _detailForRun(run, jobId, lang, siblingRuns, prefetchedDetail) {
  var runId  = run.run_id;
  var lc     = (run.state && run.state.life_cycle_state) || '';
  var result = (run.state && run.state.result_state) || '';
  var run_history = _parseRunHistory(siblingRuns || []);
  var run_history_with_tasks = _fetchRunsWithTasks(siblingRuns || []);

  // Devolver solo si sigue activo
  var activeStates = ['PENDING', 'RUNNING', 'TERMINATING', 'QUEUED'];
  if (activeStates.indexOf(lc) !== -1) {
    return { status: lc, job_id: jobId, run_id: runId, run_history: run_history, run_history_with_tasks: run_history_with_tasks };
  }

  // Terminal: TERMINATED, INTERNAL_ERROR, SKIPPED, etc.
  // Paginado: sin esto un job de >100 tasks llega truncado y las fallas de la página 2
  // (las reales) quedan invisibles detrás del centinela.
  var runDetail = prefetchedDetail || _getRunDetailPaged(runId);

  if (result !== 'FAILED') {
    var tasks = [];
    if (Array.isArray(runDetail.tasks)) {
      for (var i = 0; i < runDetail.tasks.length; i++) {
        var t    = runDetail.tasks[i];
        var meta = _extractTaskMeta(t);
        tasks.push({
          task_key:         t.task_key,
          result_state:     (t.state && t.state.result_state)     || '',
          life_cycle_state: (t.state && t.state.life_cycle_state) || '',
          duration_ms:      t.execution_duration || 0,
          depends_on:       (t.depends_on || []).map(function(d) { return d.task_key; }),
          task_type:        meta.task_type,
          notebook_path:    meta.notebook_path,
          notebook_params:  meta.notebook_params,
          subjob_id:        meta.subjob_id
        });
      }
    }
    return {
      status:                  result || lc,
      job_id:                  jobId,
      run_id:                  runId,
      start_time:              runDetail.start_time || 0,
      end_time:                runDetail.end_time   || 0,
      tasks:                   tasks,
      run_history:             run_history,
      run_history_with_tasks:  run_history_with_tasks
    };
  }

  var failedTasks = _parseFailedTasks(runDetail);
  var primary     = failedTasks.length > 0 ? failedTasks[0] : null;

  // Per-task diagnosis: when a job fails with several tasks, each FAILED task gets its
  // OWN error trace + its OWN AI diagnosis (previously only the first task was diagnosed).
  // Subjob tasks are not diagnosed here — they resolve to a "open child job →" navigation.
  var failed_tasks = failedTasks.map(function(t) {
    var entry = {
      task_key:      t.task_key,
      is_notebook:   t.is_notebook,
      is_subjob:     t.is_subjob,
      subjob_id:      t.subjob_id || null,
      subjob_name:    null,
      subjob_run_id:  null,
      is_sentinel:   !!t.is_sentinel,
      state_message: '',
      diagnosis:     '',
      is_code_error: false
    };
    if (t.is_subjob && t.subjob_id) {
      // Resolver el nombre del job hijo para navegar con un header descriptivo (solo subjobs fallidos)
      try { var jd = _getJobDetailPaged(t.subjob_id); entry.subjob_name = (jd && jd.settings && jd.settings.name) || null; } catch (e) {}
      // Y el run EXACTO que disparo este padre. runs/get no lo trae (run_job_output null ahi):
      // hay que pedir runs/get-output sobre el run_id de la task.
      if (t.task_run_id) {
        try { entry.subjob_run_id = _childRunId(_dbxFetch('/api/2.1/jobs/runs/get-output?run_id=' + t.task_run_id)); }
        catch (e) {}
      }
    } else if (t.is_sentinel) {
      // El centinela sólo marca el run como FAILED — su traceback lista las tasks reales,
      // así que se guarda para el raw log, pero no se le gasta una llamada al LLM.
      entry.state_message = _getTaskErrorMessage(t);
    } else {
      var tmsg  = _getTaskErrorMessage(t);
      var tdiag = analizarErrorConLLM(tmsg, lang);
      entry.state_message = tmsg;
      entry.diagnosis     = tdiag.summary;
      entry.is_code_error = tdiag.is_code_error;
    }
    return entry;
  });

  // Top-level fields kept for backward-compat (single-task layout reads these): first failed task.
  var primaryEntry = failed_tasks.length > 0 ? failed_tasks[0] : null;
  var task_key     = primary ? primary.task_key : 'desconocida';
  var state_msg    = primaryEntry && primaryEntry.state_message
                       ? primaryEntry.state_message
                       : (run.state.state_message || 'Sin mensaje de error disponible.');

  return {
    status:               'FAILED',
    job_id:               jobId,
    run_id:               runId,
    task_key:             task_key,
    is_primary_notebook:  primary ? primary.is_notebook : false,
    failed_tasks:         failed_tasks,
    state_message:        state_msg,
    diagnosis:            primaryEntry ? primaryEntry.diagnosis : '',
    is_code_error:        primaryEntry ? primaryEntry.is_code_error : false,
    tasks_dag: (function() {
      var dag = [];
      if (Array.isArray(runDetail.tasks)) {
        var seen = {};
        for (var di = 0; di < runDetail.tasks.length; di++) {
          var dt = runDetail.tasks[di];
          if (!seen[dt.task_key]) {
            seen[dt.task_key] = true;
            var dtMeta = _extractTaskMeta(dt);
            dag.push({
              task_key:         dt.task_key,
              result_state:     (dt.state && dt.state.result_state)     || '',
              life_cycle_state: (dt.state && dt.state.life_cycle_state) || '',
              depends_on:       (dt.depends_on || []).map(function(d) { return d.task_key; }),
              task_type:        dtMeta.task_type,
              notebook_path:    dtMeta.notebook_path,
              notebook_params:  dtMeta.notebook_params,
              subjob_id:        dtMeta.subjob_id
            });
          }
        }
      }
      return dag;
    })(),
    run_history:             run_history,
    run_history_with_tasks:  run_history_with_tasks
  };
}

function getNotebookPreview(path, full) {
  try {
    var exported = _dbxFetch('/api/2.0/workspace/export?format=SOURCE&path=' + encodeURIComponent(path));
    if (!exported || !exported.content) {
      return { lines: [], total_lines: 0, truncated: false, error: 'Not found' };
    }
    var source = Utilities.newBlob(Utilities.base64Decode(exported.content)).getDataAsString();
    var lines  = source.split('\n');
    var total  = lines.length;
    if (!full && total > 30) {
      return { lines: lines.slice(0, 30), total_lines: total, truncated: true, error: null };
    }
    return { lines: lines, total_lines: total, truncated: false, error: null };
  } catch (e) {
    var msg = (e && e.message) ? e.message : '';
    if (msg.indexOf('403') !== -1 || msg.toLowerCase().indexOf('access') !== -1) {
      return { lines: [], total_lines: 0, truncated: false, error: 'Access denied' };
    }
    return { lines: [], total_lines: 0, truncated: false, error: 'Not found' };
  }
}

function _buildRunNowPayload(jobId, params) {
  var payload = { job_id: jobId };
  if (params && Object.keys(params).length) payload.notebook_params = params;
  return payload;
}

function triggerJob(jobId, notebookParams) {
  return _dbxFetch('/api/2.1/jobs/run-now', {
    method:  'post',
    payload: JSON.stringify(_buildRunNowPayload(jobId, notebookParams))
  });
}

// Default notebook params del job (unión de base_parameters de todas las notebook tasks)
// para pre-poblar el editor de parámetros antes de un trigger custom.
// Union de settings.parameters (nivel job) + base_parameters de las notebook tasks.
// Solo lo segundo dejaba el editor VACIO en un job director: sus tasks son run_job_task,
// no tienen base_parameters, y toda su parametrizacion vive en settings.parameters --
// que run_job_task si propaga al hijo. Sintoma igual al que arreglo la v82, causa distinta.
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

function getJobParams(jobId) {
  try {
    var jd = _getJobDetailPaged(jobId);
    return { params: _mergeJobParams(jd && jd.settings) };
  } catch (e) {
    return { params: {}, error: (e && e.message) || 'error' };
  }
}


function _extractTableNames(text) {
  var seen = {}, results = [];
  var re = /\b([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)(?:\.([a-zA-Z_][a-zA-Z0-9_]*))?\b/g;
  var match;
  while ((match = re.exec(text)) !== null) {
    var full = match[0], low = full.toLowerCase();
    if (/^(java|org\.|com\.|pyspark\.|spark\.|databricks\.|google\.|urllib|http|api\.\d|py4j)/i.test(full)) continue;
    if (seen[low] || results.length >= 4) continue;
    seen[low] = true;
    results.push(full);
  }
  return results;
}

function _getRunningCluster() {
  try {
    var data = _dbxFetch('/api/2.0/clusters/list');
    var clusters = data.clusters || [];
    for (var i = 0; i < clusters.length; i++) {
      if (clusters[i].state === 'RUNNING') return clusters[i].cluster_id;
    }
  } catch(e) {}
  return null;
}

function _execOnCluster(clusterId, command) {
  try {
    var ctx   = _dbxFetch('/api/1.2/contexts/create', { method: 'post', payload: JSON.stringify({ clusterId: clusterId, language: 'python' }) });
    var ctxId = ctx.id;
    var cmd   = _dbxFetch('/api/1.2/commands/execute', { method: 'post', payload: JSON.stringify({ clusterId: clusterId, contextId: ctxId, language: 'python', command: command }) });
    var cmdId = cmd.id;
    var result = null;
    for (var i = 0; i < 10; i++) {
      Utilities.sleep(2000);
      var s = _dbxFetch('/api/1.2/commands/status?clusterId=' + clusterId + '&contextId=' + ctxId + '&commandId=' + cmdId);
      if (s.status === 'Finished') { result = s.results; break; }
      if (s.status === 'Cancelled' || s.status === 'Error') break;
    }
    try { _dbxFetch('/api/1.2/contexts/destroy', { method: 'post', payload: JSON.stringify({ clusterId: clusterId, contextId: ctxId }) }); } catch(e) {}
    return result;
  } catch(e) { return null; }
}

// ── Recorte del notebook por RELEVANCIA (no por "los primeros N chars") ──────
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


function _buildHintBlock(userHint, lang) {
  var h = (userHint == null ? '' : String(userHint)).trim();
  if (!h) return '';
  if (h.length > 1000) h = h.substring(0, 1000);
  return lang === 'es'
    ? '\n\nPISTA DEL USUARIO (tenela MUY en cuenta — la dio quien conoce el pipeline):\n' + h
    : '\n\nUSER HINT (weigh it HEAVILY — provided by someone who knows the pipeline):\n' + h;
}

function pensarFix(runId, taskKey, lang, userHint) {
  lang = lang || 'en';
  var hintBlock = _buildHintBlock(userHint, lang);
  var cfg = _getConfig_();
  // 1. Detalle del run para encontrar el notebook y el task_run_id.
  // ⚠ PAGINADO OBLIGATORIO. Esto leia solo la primera pagina, y en un job de
  // >100 tasks la que falla de verdad cae en la pagina 2: `pensarFix` no la encontraba,
  // se iba con notebookPath=null y el LLM diagnosticaba SIN el codigo, proponiendo un
  // find→replace inventado que despues `aplicarFix` rechazaba con "el codigo a reemplazar
  // no se encontro". Lo unico visible en la pagina 1 era el centinela. El helper paginado
  // ya existia y lo usa todo el resto del archivo; este era el unico lugar que no.
  var runDetail = _getRunDetailPaged(runId);
  var task      = _findTaskInRun(runDetail, taskKey);
  if (!task) {
    return { error: lang === 'es'
      ? ('No se encontró la task "' + taskKey + '" en el run ' + runId + '. '
         + 'Sin la task no hay notebook ni traceback: diagnosticar igual solo produce un fix inventado.')
      : ('Task "' + taskKey + '" not found in run ' + runId + '. '
         + 'Without it there is no notebook and no traceback: diagnosing anyway only yields a made-up fix.') };
  }
  var taskRunId    = task.run_id;
  var notebookPath = task.notebook_task ? task.notebook_task.notebook_path : null;

  // 2. Error trace real
  var errorTrace = lang === 'es' ? 'Sin traceback disponible.' : 'No traceback available.';
  if (taskRunId) {
    try {
      var out = _dbxFetch('/api/2.1/jobs/runs/get-output?run_id=' + taskRunId);
      errorTrace = out.error_trace || out.error || errorTrace;
    } catch(e) {}
  }

  // 3. Contenido del notebook (si aplica)
  var notebookContent = '';
  if (notebookPath) {
    try {
      var exported = _dbxFetch('/api/2.0/workspace/export?format=SOURCE&path=' + encodeURIComponent(notebookPath));
      // ⚠ Se guarda el notebook ENTERO. Antes se cortaba en 10.000 chars, y el recorte
      // era "los primeros N": la peor heuristica posible, porque el error casi nunca
      // esta al principio. Caso medido: notebook de 20.997 chars cuya celda culpable
      // arrancaba en el 10.308 — quedaba afuera por 308 caracteres. Lo que viaja al LLM
      // lo elige _selectRelevantCode() por relevancia.
      notebookContent = Utilities.newBlob(Utilities.base64Decode(exported.content)).getDataAsString().substring(0, 200000);
    } catch(e) {}
  }

  // 4. LLM decide qué comandos correr → ejecutar en cluster para descubrir schemas Hive
  var exploredTables = [];
  var schemaContext  = '';
  var clusterId = _getRunningCluster();
  if (clusterId) {
    var discoverPayload = {
      messages: [
        {
          role: 'system',
          content: lang === 'es'
            ? ('Sos un Data Engineer experto en PySpark y Databricks Hive Metastore. ' +
               'Dado un error y el código de un notebook, decidís qué comandos Python/PySpark correr en un cluster ' +
               'para descubrir la información necesaria para diagnosticar y ARREGLAR el error. ' +
               'Respondé ÚNICAMENTE con JSON válido: {"commands":["<python code 1>","<python code 2>"]}. ' +
               'Máximo 4 comandos. Para errores de columnas: spark.sql("DESCRIBE TABLE schema.table").toPandas().to_string(). ' +
               'Para errores de TABLA/VISTA INEXISTENTE (AnalysisException: Table or view not found): NO uses DESCRIBE sobre la tabla que falta. ' +
               'En su lugar BUSCÁ el nombre correcto: spark.sql("SHOW TABLES IN <schema>").toPandas().to_string(), ' +
               'y filtrá por similitud, ej. [t for t in spark.catalog.listTables("<schema>") if "<fragmento>" in t.name]. ' +
               'Si no sabés el schema, listá los disponibles con spark.sql("SHOW DATABASES").toPandas().to_string(). ' +
               'El objetivo es encontrar la tabla real que el código debería usar. Las tablas están en Hive Metastore (NO Unity Catalog).')
            : ('You are an expert Data Engineer specializing in PySpark and Databricks Hive Metastore. ' +
               'Given an error and notebook code, decide which Python/PySpark commands to run on a cluster ' +
               'to discover the information needed to diagnose and FIX the error. ' +
               'Respond ONLY with valid JSON: {"commands":["<python code 1>","<python code 2>"]}. ' +
               'Maximum 4 commands. For column errors: spark.sql("DESCRIBE TABLE schema.table").toPandas().to_string(). ' +
               'For MISSING TABLE/VIEW errors (AnalysisException: Table or view not found): do NOT DESCRIBE the missing table. ' +
               'Instead SEARCH for the correct name: spark.sql("SHOW TABLES IN <schema>").toPandas().to_string(), ' +
               'and filter by similarity, e.g. [t for t in spark.catalog.listTables("<schema>") if "<fragment>" in t.name]. ' +
               'If unsure of the schema, list them with spark.sql("SHOW DATABASES").toPandas().to_string(). ' +
               'The goal is to find the real table the code should use. Tables are in Hive Metastore (NOT Unity Catalog).')
        },
        {
          role: 'user',
          content: 'ERROR:\n' + errorTrace.substring(0, 2000) + '\n\n' +
                   (notebookContent ? 'CÓDIGO:\n' + _selectRelevantCode(notebookContent, errorTrace, 3000) : '') +
                   hintBlock
        }
      ],
      max_tokens: 512
    };
    try {
      var discoverResp = UrlFetchApp.fetch(
        cfg.host + '/serving-endpoints/' + (cfg.llm_endpoint || 'databricks-meta-llama-3-1-70b-instruct') + '/invocations',
        { method: 'post', headers: _headers(), payload: JSON.stringify(discoverPayload), muteHttpExceptions: true }
      );
      if (discoverResp.getResponseCode() === 200) {
        var discoverData    = JSON.parse(discoverResp.getContentText());
        var discoverContent = discoverData.choices[0].message.content;
        var cmdJsonMatch    = discoverContent.match(/\{[\s\S]*\}/);
        if (cmdJsonMatch) {
          var commands = JSON.parse(cmdJsonMatch[0]).commands || [];
          for (var ci = 0; ci < commands.length; ci++) {
            var result = _execOnCluster(clusterId, commands[ci]);
            if (result && result.resultType === 'text' && result.data) {
              exploredTables.push({ name: 'cmd_' + ci, columns: [result.data.substring(0, 500)] });
              schemaContext += '--- Comando ' + (ci + 1) + ' ---\n' + result.data.substring(0, 1000) + '\n\n';
            }
          }
        }
      }
    } catch(e) {}
  }

  // 5. Prompt al LLM con schemas reales del cluster (Hive Metastore)
  var userPrompt = lang === 'es'
    ? ('ERROR:\n' + errorTrace.substring(0, 3000) + '\n\n' +
       (schemaContext   ? 'SCHEMAS REALES (Hive Metastore, DESCRIBE TABLE):\n' + schemaContext : '') +
       (notebookPath    ? 'NOTEBOOK: ' + notebookPath + '\n\n' : '') +
       (notebookContent ? 'CÓDIGO DEL NOTEBOOK:\n' + _selectRelevantCode(notebookContent, errorTrace, 8000) : '') +
       hintBlock)
    : ('ERROR:\n' + errorTrace.substring(0, 3000) + '\n\n' +
       (schemaContext   ? 'REAL SCHEMAS (Hive Metastore, DESCRIBE TABLE):\n' + schemaContext : '') +
       (notebookPath    ? 'NOTEBOOK: ' + notebookPath + '\n\n' : '') +
       (notebookContent ? 'NOTEBOOK CODE:\n' + _selectRelevantCode(notebookContent, errorTrace, 8000) : '') +
       hintBlock);

  var systemFix = lang === 'es'
    ? ('Sos un Principal Data Engineer experto en PySpark y Databricks. ' +
       'Analizás errores de notebooks y proponés fixes concretos usando los schemas REALES provistos. ' +
       'Respondé ÚNICAMENTE con JSON válido (sin texto antes ni después):\n' +
       '{"analysis":"<explicación técnica precisa en 2-3 líneas>","find":"<bloque de código exacto a reemplazar, copiado textual del notebook respetando indentación>","replace":"<código corregido>"}\n\n' +
       'REGLAS CRÍTICAS:\n' +
       '- "find" SIEMPRE debe ser un fragmento copiado textualmente del CÓDIGO DEL NOTEBOOK (no del traceback).\n' +
       '- El CÓDIGO DEL NOTEBOOK puede venir RECORTADO por relevancia: los tramos que no hacen falta se reemplazaron por una linea "#  [ ... N celdas del notebook omitidas por brevedad ... ]". Esa linea NO existe en el notebook real: NUNCA la incluyas en "find", y no propongas un "find" que cruce de un lado al otro de un marcador. Elegí un bloque contiguo de UNA sola porción mostrada.\n' +
       '- Si el error está en el notebook, encontrá el bloque problemático y proponé el reemplazo.\n' +
       '- TABLA/VISTA INEXISTENTE: si en los SCHEMAS REALES aparece una tabla correcta o de nombre similar, reemplazá el nombre incorrecto por el real. ' +
       'Si NO existe ninguna alternativa válida, como ÚLTIMA INSTANCIA comentá la(s) línea(s) ofensoras (prefijá cada una con "# ") para que el pipeline pueda continuar, y aclarálo en "analysis".\n' +
       '- NUNCA devuelvas "find":"" si podés comentar la línea. Siempre proponé una acción concreta (reemplazo real o comentar). Solo dejá "find":"" si el error es 100% de infraestructura (permiso denegado, cluster caído).\n' +
       '- Si viene una PISTA DEL USUARIO, dale MUCHO peso (la dio alguien que conoce el pipeline), pero igual validá contra los SCHEMAS REALES; si la pista contradice los datos reales, seguí los datos y aclaralo en "analysis".\n' +
       '- Preferí proponer un fix aunque no estés completamente seguro — marcalo en "analysis".')
    : ('You are a Principal Data Engineer expert in PySpark and Databricks. ' +
       'You analyze notebook errors and propose concrete fixes using the REAL schemas provided. ' +
       'Respond ONLY with valid JSON (no text before or after):\n' +
       '{"analysis":"<precise technical explanation in 2-3 lines>","find":"<exact code block to replace, copied verbatim from the notebook preserving indentation>","replace":"<corrected code>"}\n\n' +
       'CRITICAL RULES:\n' +
       '- "find" MUST always be a fragment copied verbatim from the NOTEBOOK CODE (not from the traceback).\n' +
       '- The NOTEBOOK CODE may arrive TRIMMED by relevance: irrelevant stretches were replaced by a line "#  [ ... N celdas del notebook omitidas por brevedad ... ]". That line does NOT exist in the real notebook: NEVER include it in "find", and never propose a "find" that spans across a marker. Pick a contiguous block from a SINGLE shown section.\n' +
       '- If the error is in the notebook, find the problematic block and propose the replacement.\n' +
       '- MISSING TABLE/VIEW: if the REAL SCHEMAS show a correct or similarly-named table, replace the wrong name with the real one. ' +
       'If NO valid alternative exists, as a LAST RESORT comment out the offending line(s) (prefix each with "# ") so the pipeline can continue, and note it in "analysis".\n' +
       '- NEVER return "find":"" if you can comment out the line. Always propose a concrete action (real replacement or comment-out). Only leave "find":"" if the error is 100% infrastructure (permission denied, cluster down).\n' +
       '- If a USER HINT is provided, weigh it HEAVILY (it comes from someone who knows the pipeline), but still validate it against the REAL SCHEMAS; if the hint contradicts the real data, follow the data and note it in "analysis".\n' +
       '- Prefer proposing a fix even if not completely certain — note it in "analysis".');


  var payload = {
    messages: [
      { role: 'system', content: systemFix },
      { role: 'user',   content: userPrompt }
    ],
    max_tokens: 2048
  };

  var resp = UrlFetchApp.fetch(
    cfg.host + '/serving-endpoints/' + (cfg.llm_endpoint || 'databricks-meta-llama-3-1-70b-instruct') + '/invocations',
    { method: 'post', headers: _headers(), payload: JSON.stringify(payload), muteHttpExceptions: true }
  );

  if (resp.getResponseCode() !== 200) {
    return { error: (lang === 'es' ? 'LLM no disponible — HTTP ' : 'LLM unavailable — HTTP ') + resp.getResponseCode() };
  }

  try {
    var llmData   = JSON.parse(resp.getContentText());
    var content   = llmData.choices[0].message.content;
    var jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON');
    var parsed = JSON.parse(jsonMatch[0]);
    parsed.notebook_path   = notebookPath || null;
    parsed.explored_tables = exploredTables;
    return parsed;
  } catch(e) {
    return { error: lang === 'es' ? 'No se pudo parsear la respuesta del LLM.' : 'Could not parse the LLM response.' };
  }
}

function aplicarFix(notebookPath, findCode, replaceCode) {
  try {
    var exported = _dbxFetch('/api/2.0/workspace/export?format=SOURCE&path=' + encodeURIComponent(notebookPath));
    var content  = Utilities.newBlob(Utilities.base64Decode(exported.content)).getDataAsString();
    if (content.indexOf(findCode) === -1) {
      return { success: false, error: 'El código a reemplazar no se encontró exactamente en el notebook.' };
    }
    var fixed   = content.replace(findCode, replaceCode);
    var encoded = Utilities.base64Encode(Utilities.newBlob(fixed).getBytes());
    _dbxFetch('/api/2.0/workspace/import', {
      method:  'post',
      payload: JSON.stringify({ path: notebookPath, format: 'SOURCE', language: 'PYTHON', content: encoded, overwrite: true })
    });
    // Log the fix in UserProperties
    try {
      var props   = PropertiesService.getUserProperties();
      var entry   = _buildFixLogEntry(notebookPath, findCode, replaceCode);
      var updated = _appendFixLog(props.getProperty('fix_history'), entry);
      props.setProperty('fix_history', JSON.stringify(updated));
    } catch(e) {}
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ── Nova v2 — Pure helpers ───────────────────────────────────────────────────

function _parseConfig(json) {
  var defaults = { host: '', auth: 'oauth', client_id: '', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '', lang: 'en' };
  try {
    var c = JSON.parse(json || '{}');
    return {
      host:            String(c.host            || defaults.host),
      // Configs saved before OAuth existed have a token and no `auth`: they keep working as PAT.
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

// Normaliza la config a la estructura multi-workspace. Migra el formato viejo (un solo
// workspace con host/token al nivel raíz) a workspaces[0]. Clampa el índice activo.
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

// Complete = enough to call Databricks: OAuth only needs the host (the token comes from "Connect").
function _isConfigComplete(config) {
  return !!(config.host && (config.auth === 'pat' ? config.token : true));
}

function _normHost(host) {
  var h = String(host || '').trim().replace(/\/+$/, '');
  if (h && !/^https?:\/\//i.test(h)) h = 'https://' + h;
  return h;
}

// One OAuth service (= one token set in UserProperties) per workspace host.
function _oauthServiceName(host) {
  return 'dbx_' + _normHost(host).replace(/^https?:\/\//i, '').replace(/[^A-Za-z0-9]/g, '_');
}

function _stripClientSecret(payload) {
  delete payload.client_secret;
  return payload;
}

// REQUIRE_OAUTH: every workspace goes to OAuth and loses its saved PAT. Returns true if it changed something.
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

function _parseFavorites(json) {
  try { var a = JSON.parse(json || '[]'); return Array.isArray(a) ? a.map(String) : []; }
  catch(e) { return []; }
}

function _toggleFavoriteLogic(favorites, jobId) {
  var id = String(jobId);
  var idx = favorites.indexOf(id);
  if (idx === -1) return favorites.concat([id]);
  return favorites.filter(function(x) { return x !== id; });
}

function _buildCancelPayload(runId) {
  return { run_id: runId };
}

function _buildFixLogEntry(notebookPath, find, replace, ts) {
  return {
    ts:            ts || new Date().toISOString(),
    notebook_path: notebookPath,
    find:          String(find).substring(0, 800),
    replace:       String(replace).substring(0, 800)
  };
}

function _appendFixLog(currentJson, entry) {
  var log = [];
  try { log = JSON.parse(currentJson || '[]'); } catch(e) {}
  if (!Array.isArray(log)) log = [];
  log.push(entry);
  if (log.length > 50) log = log.slice(log.length - 50);
  // Guard de tamaño: cada valor de UserProperties topa en 9KB → dropear los más viejos hasta entrar.
  while (log.length > 1 && JSON.stringify(log).length > 8500) log.shift();
  return log;
}

function _parseRunHistory(runs) {
  return (runs || []).map(function(r) {
    return {
      run_id:           r.run_id,
      result_state:     (r.state && r.state.result_state)     || '',
      life_cycle_state: (r.state && r.state.life_cycle_state) || '',
      start_time:       r.start_time         || 0,
      duration_ms:      r.execution_duration || 0
    };
  });
}

function _fetchRunsWithTasks(runs) {
  if (!runs || !runs.length) return [];
  var config  = _getConfig_();
  var authHdr = { 'Authorization': _bearer_(config) };
  function _req(runId, pageToken) {
    return {
      // 2.2 maneja runs grandes (>100 tasks). 2.1 devuelve 400 para esos jobs
      // → el body de error es JSON válido, así que sin chequear el HTTP code
      // se parseaba como un run vacío (state='', tasks=[]) → labels "— · ?" en compare.
      url:                config.host + _runPageUrl(runId, pageToken),
      headers:            authHdr,
      muteHttpExceptions: true
    };
  }
  function _body(resp) {
    if (resp.getResponseCode() !== 200) return null;
    try { var r = JSON.parse(resp.getContentText()); return (r && r.run_id) ? r : null; }
    catch (e) { return null; }
  }

  // Ronda 1: primera página de cada run, en paralelo.
  var pagesByIdx = UrlFetchApp.fetchAll(runs.map(function(r) { return _req(r.run_id, null); }))
                              .map(function(resp) { var b = _body(resp); return b ? [b] : []; });

  // Rondas siguientes: sólo los runs que trajeron next_page_token (>100 tasks). También
  // en paralelo — un solo fetchAll por ronda, no una cascada por run.
  for (var round = 1; round < _MAX_RUN_PAGES_; round++) {
    var idxs = [], reqs = [];
    for (var i = 0; i < pagesByIdx.length; i++) {
      var last = pagesByIdx[i][pagesByIdx[i].length - 1];
      if (last && last.next_page_token) { idxs.push(i); reqs.push(_req(last.run_id, last.next_page_token)); }
    }
    if (!reqs.length) break;
    var more = UrlFetchApp.fetchAll(reqs);
    for (var j = 0; j < idxs.length; j++) {
      var b = _body(more[j]);
      if (b) pagesByIdx[idxs[j]].push(b); else pagesByIdx[idxs[j]][pagesByIdx[idxs[j]].length - 1].next_page_token = null;
    }
  }

  return pagesByIdx.map(function(pages, idx) {
    var base = runs[idx];
    var r    = _mergeRunPages(pages);
    if (!r) {
      return {
        run_id:           base.run_id,
        result_state:     (base.state && base.state.result_state)     || '',
        life_cycle_state: (base.state && base.state.life_cycle_state) || '',
        start_time:       base.start_time         || 0,
        duration_ms:      base.execution_duration || 0,
        tasks:            []
      };
    }
    return {
      run_id:           r.run_id,
      result_state:     (r.state && r.state.result_state)     || '',
      life_cycle_state: (r.state && r.state.life_cycle_state) || '',
      start_time:       r.start_time         || 0,
      duration_ms:      r.execution_duration || 0,
      // Dedup: con repairs la misma task_key vuelve una vez por intento y la tabla de
      // comparación la mostraría repetida (y el flakiness contaría de más).
      tasks: _dedupTasksByKey(r.tasks || []).map(function(t) {
        return {
          task_key:     t.task_key,
          result_state: (t.state && t.state.result_state) || '',
          duration_ms:  t.execution_duration || 0
        };
      })
    };
  });
}

// Cerrar sesión / reset total: borra toda la config (workspaces + tokens) → vuelve al setup wizard.
function resetConfig() {
  _getMulti_().workspaces.forEach(function(w) {
    if (_wsAuth_(w) === 'oauth') { try { _oauthService_(w).reset(); } catch (e) {} }
  });
  PropertiesService.getUserProperties().deleteProperty('bedbricks_config');
  return {};
}

// ── Nova v2 — New backend functions ─────────────────────────────────────────

function getOrchestratorStatus() {
  var config = _getConfig_();
  if (!config.pinned_job_id) return { status: 'NO_PINNED_JOB' };
  var listData = _dbxFetch('/api/2.1/jobs/runs/list?job_id=' + config.pinned_job_id + '&limit=1');
  if (!listData.runs || listData.runs.length === 0) {
    return { status: 'NO_RUNS', tasks_done: 0, tasks_total: 0 };
  }
  var run    = listData.runs[0];
  var lc     = run.state.life_cycle_state;
  var rs     = run.state.result_state || '';
  var status = rs || lc;
  var tasks_done = 0, tasks_total = 0, are_subjobs = false;
  try {
    // Antes iba por 2.1, que para un job de >100 tasks devuelve
    // 400 "Resources with more than 100 tasks can only be handled by API 2.2":
    // el catch se lo comía y la barra de progreso quedaba siempre en 0/0.
    var runDetail = _getRunDetailPaged(run.run_id);
    var tasks = _dedupTasksByKey((runDetail && runDetail.tasks) || []);
    tasks_total = tasks.length;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].state && tasks[i].state.result_state === 'SUCCESS') tasks_done++;
    }
    are_subjobs = _countsAreSubjobs(tasks);
  } catch(e) {}
  return {
    status:      status,
    run_id:      run.run_id,
    start_time:  run.start_time  || 0,
    end_time:    run.end_time    || 0,
    tasks_done:  tasks_done,
    tasks_total: tasks_total,
    // En un director el denominador son las olas (7), no las tasks reales (~174):
    // la barra es correcta pero el rotulo "tasks OK" enganiaba por 25x.
    counts_are_subjobs: are_subjobs
  };
}

// What the frontend gets: never the token itself, only whether the workspace is usable.
function getConfig() {
  var c = _getConfig_();
  return {
    host:            c.host,
    auth:            c.auth,
    has_client_id:   !!(String(c.client_id || '').trim() || _defaultClientId_()),
    has_token:       !!c.token,
    configured:      _isConfigComplete(c),
    connected:       c.auth === 'pat' ? !!c.token : _oauthConnected_(c),
    require_oauth:   _requireOAuth_(),
    llm_endpoint:    c.llm_endpoint,
    pinned_job_id:   c.pinned_job_id,
    pinned_job_name: c.pinned_job_name,
    lang:            c.lang,
    workspace_name:  c.workspace_name,
    active:          _getMulti_().active
  };
}

// Aplica cambios al workspace ACTIVO (host/auth/client_id/token/llm_endpoint/pinned) y a lang (global).
// Mantiene la firma original: el setup wizard y los saves de Settings siguen funcionando igual.
function saveConfig(config) {
  var props = PropertiesService.getUserProperties();
  var multi = _getMulti_();
  if (!multi.workspaces.length) {
    multi.workspaces.push({ name: 'Workspace 1', host: '', auth: 'oauth', client_id: '', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' });
    multi.active = 0;
  }
  var ws = multi.workspaces[multi.active] || multi.workspaces[0];
  if (typeof config.host            !== 'undefined') ws.host            = _normHost(config.host);
  if (typeof config.auth            !== 'undefined') ws.auth            = (config.auth === 'pat' && !_requireOAuth_()) ? 'pat' : 'oauth';
  if (typeof config.client_id       !== 'undefined') ws.client_id       = String(config.client_id).trim();
  if (typeof config.token           !== 'undefined' && !_requireOAuth_()) ws.token = String(config.token).trim();
  if (ws.auth === 'oauth')                                              ws.token        = '';   // switching to OAuth drops the PAT
  if (typeof config.llm_endpoint    !== 'undefined') ws.llm_endpoint    = String(config.llm_endpoint).trim();
  if (typeof config.pinned_job_id   !== 'undefined') ws.pinned_job_id   = String(config.pinned_job_id);
  if (typeof config.pinned_job_name !== 'undefined') ws.pinned_job_name = String(config.pinned_job_name);
  if (typeof config.lang            !== 'undefined') multi.lang         = String(config.lang);
  props.setProperty('bedbricks_config', JSON.stringify(multi));
  return getConfig();
}

// ── Multi-workspace management ───────────────────────────────────────────────
function _saveMulti_(multi) {
  PropertiesService.getUserProperties().setProperty('bedbricks_config', JSON.stringify(multi));
}

// Lista para el frontend: nombres + host (sin exponer tokens) + índice activo.
function getWorkspaces() {
  var multi = _getMulti_();
  return {
    active: multi.active,
    require_oauth: _requireOAuth_(),
    has_default_client_id: !!_defaultClientId_(),
    workspaces: multi.workspaces.map(function(w) {
      var auth = _wsAuth_(w);
      return { name: w.name, host: w.host, auth: auth, client_id: w.client_id || '', has_token: !!w.token,
               connected: auth === 'pat' ? !!w.token : _oauthConnected_(w) };
    })
  };
}

// auth/clientId are optional (older frontends call with 3 arguments = PAT).
function addWorkspace(name, host, token, auth, clientId) {
  var multi = _getMulti_();
  var mode = (auth === 'pat' || (auth == null && token)) && !_requireOAuth_() ? 'pat' : 'oauth';
  multi.workspaces.push({
    name:            String(name || ('Workspace ' + (multi.workspaces.length + 1))).trim(),
    host:            _normHost(host),
    auth:            mode,
    client_id:       String(clientId || '').trim(),
    token:           mode === 'pat' ? String(token || '').trim() : '',
    llm_endpoint:    '', pinned_job_id: '', pinned_job_name: ''
  });
  multi.active = multi.workspaces.length - 1;   // activar el recién agregado
  _saveMulti_(multi);
  return getWorkspaces();
}

function updateWorkspace(index, name, host, token, auth, clientId) {
  var multi = _getMulti_();
  var ws = multi.workspaces[index];
  if (!ws) return getWorkspaces();
  if (name  != null && String(name).trim())  ws.name  = String(name).trim();
  if (host  != null && String(host).trim())  ws.host  = _normHost(host);
  if (auth  != null) ws.auth = (auth === 'pat' && !_requireOAuth_()) ? 'pat' : 'oauth';
  if (clientId != null) ws.client_id = String(clientId).trim();
  if (ws.auth === 'pat' && token != null && String(token).trim()) ws.token = String(token).trim();   // vacío = mantener el actual
  if (ws.auth === 'oauth') ws.token = '';
  _saveMulti_(multi);
  return getWorkspaces();
}

function deleteWorkspace(index) {
  var multi = _getMulti_();
  if (index >= 0 && index < multi.workspaces.length) {
    var gone = multi.workspaces[index];
    var shared = multi.workspaces.some(function(w, i) { return i !== index && _normHost(w.host) === _normHost(gone.host); });
    if (!shared && _wsAuth_(gone) === 'oauth') { try { _oauthService_(gone).reset(); } catch (e) {} }
    multi.workspaces.splice(index, 1);
    if (multi.active >= multi.workspaces.length) multi.active = Math.max(0, multi.workspaces.length - 1);
  }
  _saveMulti_(multi);
  return getWorkspaces();
}

function switchWorkspace(index) {
  var multi = _getMulti_();
  if (index >= 0 && index < multi.workspaces.length) multi.active = index;
  _saveMulti_(multi);
  return getConfig();
}

function getServingEndpoints() {
  try {
    return _parseServingEndpoints(_dbxFetch('/api/2.0/serving-endpoints'));
  } catch(e) { return []; }
}

function setPinnedJob(jobId, jobName) {
  return saveConfig({ pinned_job_id: String(jobId), pinned_job_name: String(jobName || jobId) });
}

function clearPinnedJob() {
  return saveConfig({ pinned_job_id: '', pinned_job_name: '' });
}

function getFavorites() {
  var json = PropertiesService.getUserProperties().getProperty('favorites');
  return _parseFavorites(json);
}

function toggleFavorite(jobId) {
  var props   = PropertiesService.getUserProperties();
  var current = _parseFavorites(props.getProperty('favorites'));
  var updated = _toggleFavoriteLogic(current, jobId);
  props.setProperty('favorites', JSON.stringify(updated));
  return updated;
}

function cancelRun(runId) {
  return _dbxFetch('/api/2.1/jobs/runs/cancel', {
    method:  'post',
    payload: JSON.stringify(_buildCancelPayload(runId))
  });
}

function getFixHistory() {
  try {
    var json = PropertiesService.getUserProperties().getProperty('fix_history') || '[]';
    var log  = JSON.parse(json);
    if (!Array.isArray(log)) return [];
    return log.slice().reverse();
  } catch(e) { return []; }
}

function getClusters() {
  var data = _dbxFetch('/api/2.0/clusters/list');
  return (data.clusters || []).map(function(c) {
    var workers = c.num_workers !== undefined ? String(c.num_workers) :
                  (c.autoscale ? c.autoscale.min_workers + '–' + c.autoscale.max_workers : '—');
    return {
      cluster_id:        c.cluster_id,
      cluster_name:      c.cluster_name || c.cluster_id,
      state:             c.state || '',
      start_time:        c.start_time  || null,
      num_workers:       workers,
      creator_user_name: c.creator_user_name || ''
    };
  }).sort(function(a, b) { return a.cluster_name.localeCompare(b.cluster_name); });
}

function startCluster(clusterId) {
  return _dbxFetch('/api/2.0/clusters/start', {
    method: 'post', payload: JSON.stringify({ cluster_id: clusterId })
  });
}

function terminateCluster(clusterId) {
  return _dbxFetch('/api/2.0/clusters/delete', {
    method: 'post', payload: JSON.stringify({ cluster_id: clusterId })
  });
}

// Scheduled runs are PER USER: the list lives in the user's UserProperties and stores no token. The
// time-based trigger runs as the user who created it, so _onScheduledRun reads THAT user's list and
// gets THEIR token (OAuth refresh or PAT) at run time.
// Before this, the list lived in the shared Script Properties with a copy of each user's host + token,
// and any user's trigger ran everybody's items: _dropSharedSchedule_ deletes that leftover.
var SCHEDULE_KEY_ = 'bedbricks_scheduled';

function _scheduleList_() {
  try { return JSON.parse(PropertiesService.getUserProperties().getProperty(SCHEDULE_KEY_) || '[]'); } catch(e) { return []; }
}

function _scheduleSave_(list) {
  PropertiesService.getUserProperties().setProperty(SCHEDULE_KEY_, JSON.stringify(list));
}

function _dropSharedSchedule_() {
  try { PropertiesService.getScriptProperties().deleteProperty(SCHEDULE_KEY_); } catch(e) {}
}

function scheduleJob(jobId, jobName, epochMs) {
  var cfg = _getConfig_();
  _bearer_(cfg);   // fail now (NEEDS_AUTH) rather than silently at run time
  var trigger = ScriptApp.newTrigger('_onScheduledRun')
    .timeBased()
    .at(new Date(parseInt(epochMs, 10)))
    .create();
  var triggerId = trigger.getUniqueId();
  var list = _scheduleList_();
  list.push({
    id:        triggerId,
    jobId:     String(jobId),
    jobName:   String(jobName),
    epochMs:   parseInt(epochMs, 10),
    host:      _normHost(cfg.host),
    createdAt: new Date().toISOString()
  });
  _scheduleSave_(list);
  return { triggerId: triggerId, jobId: jobId, jobName: jobName, epochMs: epochMs };
}

function getScheduledJobs() {
  _dropSharedSchedule_();
  return _scheduleList_();
}

function cancelScheduledJob(triggerId) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getUniqueId() === triggerId) {
      try { ScriptApp.deleteTrigger(triggers[i]); } catch(e) {}
      break;
    }
  }
  _scheduleSave_(_scheduleList_().filter(function(item) { return item.id !== triggerId; }));
  return { cancelled: true };
}

function _onScheduledRun() {
  _dropSharedSchedule_();
  var list = _scheduleList_();
  var multi = _getMulti_();
  var now = new Date().getTime();
  var remaining = [];
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (item.error || item.epochMs > now + 5 * 60 * 1000) { remaining.push(item); continue; }
    try {
      var ws = multi.workspaces.filter(function(w) { return _normHost(w.host) === _normHost(item.host); })[0];
      if (!ws) throw new Error('workspace ' + item.host + ' no longer configured');
      var resp = UrlFetchApp.fetch(_normHost(ws.host) + '/api/2.1/jobs/run-now', {
        method: 'post',
        headers: { 'Authorization': _bearer_(ws), 'Content-Type': 'application/json' },
        payload: JSON.stringify({ job_id: item.jobId }),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() >= 300) throw new Error('HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().substring(0, 150));
    } catch(e) {
      item.error = String(e.message || e).substring(0, 200);   // stays in the list so the UI shows it failed
      remaining.push(item);
    }
    for (var ti = 0; ti < triggers.length; ti++) {
      if (triggers[ti].getUniqueId() === item.id) {
        try { ScriptApp.deleteTrigger(triggers[ti]); } catch(e) {}
        break;
      }
    }
  }
  _scheduleSave_(remaining);
}

function doGet(e) {
  // ── Manifest para PWA ───────────────────────────────────────────────────────
  if (e && e.parameter && e.parameter.page === 'manifest') {
    var appUrl = ScriptApp.getService().getUrl();
    var manifest = {
      name:             'Bedbricks',
      short_name:       'Bedbricks',
      start_url:        appUrl,
      display:          'standalone',
      theme_color:      '#FF3621',
      background_color: '#0f0f0f',
      icons: [{ src: 'https://cdn.jsdelivr.net/gh/404mqs/bedbricks@main/apple-touch-icon.png', type: 'image/png', sizes: '180x180' }]
    };
    return ContentService
      .createTextOutput(JSON.stringify(manifest))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var allowed = (PropertiesService.getScriptProperties().getProperty('ALLOWED_EMAILS') || '')
    .split(',').map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
  if (allowed.length > 0) {
    var userEmail = Session.getActiveUser().getEmail().toLowerCase();
    if (allowed.indexOf(userEmail) === -1) {
      return HtmlService.createHtmlOutput(
        '<body style="background:#0f172a;color:#f87171;font-family:sans-serif;padding:40px;text-align:center">' +
        '<h2>Access denied</h2><p>' + userEmail + '</p></body>'
      );
    }
  }
  // OAuth return from Databricks (web-app redirect mode, see _webappAuthReturn_)
  if (e && e.parameter && e.parameter.state && (e.parameter.code || e.parameter.error) && _webappRedirect_()) {
    return _webappAuthReturn_(e.parameter);
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle('Bedbricks');
}
