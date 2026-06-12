// Bedbricks — Backend
// All config is stored per-user in UserProperties under 'bedbricks_config'.

// Estructura multi-workspace en UserProperties 'bedbricks_config':
//   { active: <idx>, lang: 'es'|'en', workspaces: [{name, host, token, llm_endpoint, pinned_job_id, pinned_job_name}] }
// _getConfig_() devuelve el workspace ACTIVO aplanado (+ lang global) para no tocar los call sites
// que usan cfg.host / cfg.token / cfg.llm_endpoint / cfg.pinned_job_id / cfg.lang.
function _getMulti_() {
  try { return _parseMultiConfig(PropertiesService.getUserProperties().getProperty('bedbricks_config') || '{}'); }
  catch(e) { return { active: 0, lang: 'en', workspaces: [] }; }
}

function _activeWorkspace(multi) {
  var ws = multi.workspaces[multi.active];
  if (!ws) return { name: '', host: '', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' };
  return ws;
}

function _getConfig_() {
  var multi = _getMulti_();
  var ws    = _activeWorkspace(multi);
  return {
    host:            ws.host,
    token:           ws.token,
    llm_endpoint:    ws.llm_endpoint,
    pinned_job_id:   ws.pinned_job_id,
    pinned_job_name: ws.pinned_job_name,
    lang:            multi.lang,
    workspace_name:  ws.name
  };
}

function _headers() {
  var token = _getConfig_().token;
  if (!token) throw new Error('Token not configured — open Settings');
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
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

function _parseFailedTasks(runData) {
  if (!runData || !Array.isArray(runData.tasks)) return [];
  // Cuando hay repairs, la API devuelve la misma task_key varias veces (una por intento).
  // Usamos un mapa para deduplicar, quedándonos con la última ocurrencia (más reciente).
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

// Últimos 5 runs POR job, en paralelo. La runs/list global no sirve para los dots:
// solo trae los runs más recientes del workspace (y topa en limit=25), así que un job
// que corre 1×/día aparece 1 sola vez → 1 puntito. Esto pide runs/list?job_id&limit=5
// por cada job y replica exactamente lo que muestra Databricks.
function _fetchJobsDots(jobIds) {
  if (!jobIds || !jobIds.length) return {};
  var config  = _getConfig_();
  var authHdr = { 'Authorization': 'Bearer ' + config.token };
  var requests = jobIds.map(function(id) {
    return {
      url:                config.host + '/api/2.1/jobs/runs/list?job_id=' + id + '&limit=5&expand_tasks=false',
      headers:            authHdr,
      muteHttpExceptions: true
    };
  });
  var responses = UrlFetchApp.fetchAll(requests);
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
  var jobsData = _dbxFetch('/api/2.1/jobs/list?expand_tasks=false');
  var runsData = _dbxFetch('/api/2.1/jobs/runs/list?limit=25&expand_tasks=false');
  var runs = runsData.runs || [];

  var jobNames = {};
  (jobsData.jobs || []).forEach(function(j) {
    jobNames[String(j.job_id)] = (j.settings && j.settings.name) ? j.settings.name : String(j.job_id);
  });

  var jobsArr   = jobsData.jobs || [];
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
  var run    = listData.runs[0];
  var runId  = run.run_id;
  var lc     = run.state.life_cycle_state;
  var result = run.state.result_state || '';
  var run_history = _parseRunHistory(listData.runs);
  var run_history_with_tasks = _fetchRunsWithTasks(listData.runs);

  // Devolver solo si sigue activo
  var activeStates = ['PENDING', 'RUNNING', 'TERMINATING', 'QUEUED'];
  if (activeStates.indexOf(lc) !== -1) {
    return { status: lc, job_id: jobId, run_id: runId, run_history: run_history, run_history_with_tasks: run_history_with_tasks };
  }

  // Terminal: TERMINATED, INTERNAL_ERROR, SKIPPED, etc.
  var runDetail = _dbxFetch('/api/2.2/jobs/runs/get?run_id=' + runId);

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
      subjob_id:     t.subjob_id || null,
      subjob_name:   null,
      state_message: '',
      diagnosis:     '',
      is_code_error: false
    };
    if (t.is_subjob && t.subjob_id) {
      // Resolver el nombre del job hijo para navegar con un header descriptivo (solo subjobs fallidos)
      try { var jd = _dbxFetch('/api/2.1/jobs/get?job_id=' + t.subjob_id); entry.subjob_name = (jd.settings && jd.settings.name) || null; } catch (e) {}
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
function getJobParams(jobId) {
  try {
    var jd    = _dbxFetch('/api/2.1/jobs/get?job_id=' + jobId);
    var tasks = (jd.settings && jd.settings.tasks) || [];
    var merged = {};
    for (var i = 0; i < tasks.length; i++) {
      var bp = tasks[i].notebook_task && tasks[i].notebook_task.base_parameters;
      if (bp) { for (var k in bp) { if (bp.hasOwnProperty(k)) merged[k] = bp[k]; } }
    }
    return { params: merged };
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
  // 1. Detalle del run para encontrar el notebook y el task_run_id
  var runDetail = _dbxFetch('/api/2.2/jobs/runs/get?run_id=' + runId);
  var notebookPath = null;
  var taskRunId    = null;
  if (Array.isArray(runDetail.tasks)) {
    for (var i = 0; i < runDetail.tasks.length; i++) {
      var t = runDetail.tasks[i];
      if (t.task_key === taskKey) {
        taskRunId = t.run_id;
        if (t.notebook_task) notebookPath = t.notebook_task.notebook_path;
        break;
      }
    }
  }

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
      notebookContent = Utilities.newBlob(Utilities.base64Decode(exported.content)).getDataAsString().substring(0, 10000);
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
                   (notebookContent ? 'CÓDIGO:\n' + notebookContent.substring(0, 3000) : '') +
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
       (notebookContent ? 'CÓDIGO DEL NOTEBOOK:\n' + notebookContent : '') +
       hintBlock)
    : ('ERROR:\n' + errorTrace.substring(0, 3000) + '\n\n' +
       (schemaContext   ? 'REAL SCHEMAS (Hive Metastore, DESCRIBE TABLE):\n' + schemaContext : '') +
       (notebookPath    ? 'NOTEBOOK: ' + notebookPath + '\n\n' : '') +
       (notebookContent ? 'NOTEBOOK CODE:\n' + notebookContent : '') +
       hintBlock);

  var systemFix = lang === 'es'
    ? ('Sos un Principal Data Engineer experto en PySpark y Databricks. ' +
       'Analizás errores de notebooks y proponés fixes concretos usando los schemas REALES provistos. ' +
       'Respondé ÚNICAMENTE con JSON válido (sin texto antes ni después):\n' +
       '{"analysis":"<explicación técnica precisa en 2-3 líneas>","find":"<bloque de código exacto a reemplazar, copiado textual del notebook respetando indentación>","replace":"<código corregido>"}\n\n' +
       'REGLAS CRÍTICAS:\n' +
       '- "find" SIEMPRE debe ser un fragmento copiado textualmente del CÓDIGO DEL NOTEBOOK (no del traceback).\n' +
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
  var defaults = { host: '', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '', lang: 'en' };
  try {
    var c = JSON.parse(json || '{}');
    return {
      host:            String(c.host            || defaults.host),
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

function _isConfigComplete(config) {
  return !!(config.host && config.token);
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
  var authHdr = { 'Authorization': 'Bearer ' + config.token };
  var requests = runs.map(function(r) {
    return {
      // 2.2 maneja runs grandes (>100 tasks). 2.1 devuelve 400 para el Orquestador y
      // similares → el body de error es JSON válido, así que sin chequear el HTTP code
      // se parseaba como un run vacío (state='', tasks=[]) → labels "— · ?" en compare.
      url:                config.host + '/api/2.2/jobs/runs/get?run_id=' + r.run_id,
      headers:            authHdr,
      muteHttpExceptions: true
    };
  });
  var responses = UrlFetchApp.fetchAll(requests);
  return responses.map(function(resp, idx) {
    var base = runs[idx];
    try {
      if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode());
      var r = JSON.parse(resp.getContentText());
      if (!r || !r.run_id) throw new Error('no run_id');
      return {
        run_id:           r.run_id,
        result_state:     (r.state && r.state.result_state)     || '',
        life_cycle_state: (r.state && r.state.life_cycle_state) || '',
        start_time:       r.start_time         || 0,
        duration_ms:      r.execution_duration || 0,
        tasks: (r.tasks || []).map(function(t) {
          return {
            task_key:     t.task_key,
            result_state: (t.state && t.state.result_state) || '',
            duration_ms:  t.execution_duration || 0
          };
        })
      };
    } catch (e) {
      return {
        run_id:           base.run_id,
        result_state:     (base.state && base.state.result_state)     || '',
        life_cycle_state: (base.state && base.state.life_cycle_state) || '',
        start_time:       base.start_time         || 0,
        duration_ms:      base.execution_duration || 0,
        tasks:            []
      };
    }
  });
}

// Cerrar sesión / reset total: borra toda la config (workspaces + tokens) → vuelve al setup wizard.
function resetConfig() {
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
  var tasks_done = 0, tasks_total = 0;
  try {
    var runDetail = _dbxFetch('/api/2.1/jobs/runs/get?run_id=' + run.run_id);
    var tasks = runDetail.tasks || [];
    tasks_total = tasks.length;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].state && tasks[i].state.result_state === 'SUCCESS') tasks_done++;
    }
  } catch(e) {}
  return {
    status:      status,
    run_id:      run.run_id,
    start_time:  run.start_time  || 0,
    end_time:    run.end_time    || 0,
    tasks_done:  tasks_done,
    tasks_total: tasks_total
  };
}

function getConfig() {
  return _getConfig_();
}

// Aplica cambios al workspace ACTIVO (host/token/llm_endpoint/pinned) y a lang (global).
// Mantiene la firma original: el setup wizard y los saves de Settings siguen funcionando igual.
function saveConfig(config) {
  var props = PropertiesService.getUserProperties();
  var multi = _parseMultiConfig(props.getProperty('bedbricks_config') || '{}');
  if (!multi.workspaces.length) {
    multi.workspaces.push({ name: 'Workspace 1', host: '', token: '', llm_endpoint: '', pinned_job_id: '', pinned_job_name: '' });
    multi.active = 0;
  }
  var ws = multi.workspaces[multi.active] || multi.workspaces[0];
  if (typeof config.host            !== 'undefined') ws.host            = String(config.host).trim();
  if (typeof config.token           !== 'undefined') ws.token           = String(config.token).trim();
  if (typeof config.llm_endpoint    !== 'undefined') ws.llm_endpoint    = String(config.llm_endpoint).trim();
  if (typeof config.pinned_job_id   !== 'undefined') ws.pinned_job_id   = String(config.pinned_job_id);
  if (typeof config.pinned_job_name !== 'undefined') ws.pinned_job_name = String(config.pinned_job_name);
  if (typeof config.lang            !== 'undefined') multi.lang         = String(config.lang);
  props.setProperty('bedbricks_config', JSON.stringify(multi));
  return _getConfig_();
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
    workspaces: multi.workspaces.map(function(w) { return { name: w.name, host: w.host, has_token: !!w.token }; })
  };
}

function addWorkspace(name, host, token) {
  var multi = _getMulti_();
  multi.workspaces.push({
    name:            String(name || ('Workspace ' + (multi.workspaces.length + 1))).trim(),
    host:            String(host || '').trim(),
    token:           String(token || '').trim(),
    llm_endpoint:    '', pinned_job_id: '', pinned_job_name: ''
  });
  multi.active = multi.workspaces.length - 1;   // activar el recién agregado
  _saveMulti_(multi);
  return getWorkspaces();
}

function updateWorkspace(index, name, host, token) {
  var multi = _getMulti_();
  var ws = multi.workspaces[index];
  if (!ws) return getWorkspaces();
  if (name  != null && String(name).trim())  ws.name  = String(name).trim();
  if (host  != null && String(host).trim())  ws.host  = String(host).trim();
  if (token != null && String(token).trim()) ws.token = String(token).trim();   // vacío = mantener el actual
  _saveMulti_(multi);
  return getWorkspaces();
}

function deleteWorkspace(index) {
  var multi = _getMulti_();
  if (index >= 0 && index < multi.workspaces.length) {
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
  return _getConfig_();
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

function scheduleJob(jobId, jobName, epochMs) {
  var cfg = _getConfig_();
  var trigger = ScriptApp.newTrigger('_onScheduledRun')
    .timeBased()
    .at(new Date(parseInt(epochMs, 10)))
    .create();
  var triggerId = trigger.getUniqueId();
  var props = PropertiesService.getScriptProperties();
  var list = [];
  try { list = JSON.parse(props.getProperty('bedbricks_scheduled') || '[]'); } catch(e) {}
  list.push({
    id:        triggerId,
    jobId:     String(jobId),
    jobName:   String(jobName),
    epochMs:   parseInt(epochMs, 10),
    host:      cfg.host,
    token:     cfg.token,
    createdAt: new Date().toISOString()
  });
  props.setProperty('bedbricks_scheduled', JSON.stringify(list));
  return { triggerId: triggerId, jobId: jobId, jobName: jobName, epochMs: epochMs };
}

function getScheduledJobs() {
  var props = PropertiesService.getScriptProperties();
  try { return JSON.parse(props.getProperty('bedbricks_scheduled') || '[]'); } catch(e) { return []; }
}

function cancelScheduledJob(triggerId) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getUniqueId() === triggerId) {
      try { ScriptApp.deleteTrigger(triggers[i]); } catch(e) {}
      break;
    }
  }
  var props = PropertiesService.getScriptProperties();
  var list = [];
  try { list = JSON.parse(props.getProperty('bedbricks_scheduled') || '[]'); } catch(e) {}
  props.setProperty('bedbricks_scheduled', JSON.stringify(list.filter(function(item) { return item.id !== triggerId; })));
  return { cancelled: true };
}

function _onScheduledRun() {
  var props = PropertiesService.getScriptProperties();
  var list = [];
  try { list = JSON.parse(props.getProperty('bedbricks_scheduled') || '[]'); } catch(e) {}
  var now = new Date().getTime();
  var remaining = [];
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (item.epochMs <= now + 5 * 60 * 1000) {
      try {
        UrlFetchApp.fetch(item.host + '/api/2.1/jobs/run-now', {
          method: 'post',
          headers: { 'Authorization': 'Bearer ' + item.token, 'Content-Type': 'application/json' },
          payload: JSON.stringify({ job_id: item.jobId }),
          muteHttpExceptions: true
        });
      } catch(e) {}
      for (var ti = 0; ti < triggers.length; ti++) {
        if (triggers[ti].getUniqueId() === item.id) {
          try { ScriptApp.deleteTrigger(triggers[ti]); } catch(e) {}
          break;
        }
      }
    } else {
      remaining.push(item);
    }
  }
  props.setProperty('bedbricks_scheduled', JSON.stringify(remaining));
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
  return HtmlService.createHtmlOutputFromFile('Index')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle('Bedbricks');
}
