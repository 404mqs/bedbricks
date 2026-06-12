"""
deploy_apps_script.py — Push codigo.gs and Index.html to an Apps Script project via API.
No CLASP or PowerShell required.

Prerequisites:
  1. Copy deploy_config.example.py → deploy_config.py and fill in SCRIPT_ID.
  2. First time: python deploy_apps_script.py --auth  (opens browser for Google OAuth)
  3. Subsequent deploys: python deploy_apps_script.py
"""

import os, sys, json, urllib.request, urllib.parse, webbrowser, http.server, threading

# ── OAuth + Script config (from deploy_config.py — gitignored) ───────────────
# Copy deploy_config.example.py → deploy_config.py and fill in your values.
try:
    from deploy_config import SCRIPT_ID, DEPLOYMENT_ID, CLIENT_ID, CLIENT_SECRET
except ImportError:
    SCRIPT_ID     = "REPLACE_WITH_SCRIPT_ID"
    DEPLOYMENT_ID = "REPLACE_WITH_DEPLOYMENT_ID"
    CLIENT_ID     = "REPLACE_WITH_CLIENT_ID"
    CLIENT_SECRET = "REPLACE_WITH_CLIENT_SECRET"

# ── Rutas locales ────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOCAL_FILES = [
    ("codigo", "SERVER_JS", os.path.join(SCRIPT_DIR, "apps_script", "codigo.gs")),
    ("Index",  "HTML",      os.path.join(SCRIPT_DIR, "apps_script", "Index.html")),
]

# ── Config interna ───────────────────────────────────────────────────────────
TOKEN_FILE   = os.path.expanduser("~/.apps_script_token.json")
REDIRECT_URI = "http://localhost:8080"
SCOPE        = " ".join([
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.deployments",
])
TOKEN_URL = "https://oauth2.googleapis.com/token"
AUTH_URL  = "https://accounts.google.com/o/oauth2/auth"
API_BASE  = "https://script.googleapis.com/v1/projects"


# ─────────────────────────────────────────────────────────────────────────────
def _post_form(url, params):
    req = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(params).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    return json.loads(urllib.request.urlopen(req).read())


def _get_access_token():
    if not os.path.exists(TOKEN_FILE):
        print("No hay token guardado. Ejecuta primero: python deploy_apps_script.py --auth")
        sys.exit(1)
    data   = json.load(open(TOKEN_FILE))
    tokens = _post_form(TOKEN_URL, {
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "refresh_token": data["refresh_token"],
        "grant_type":    "refresh_token",
    })
    if "access_token" not in tokens:
        print("Error al renovar token:", tokens)
        print("Puede que el token haya expirado o los scopes cambiaron. Corré --auth de nuevo.")
        sys.exit(1)
    return tokens["access_token"]


def _api(method, url, headers, payload=None):
    body = json.dumps(payload).encode() if payload else None
    req  = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} en {url}: {e.read().decode()[:400]}")
        sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
def do_auth():
    code_holder = []

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "code" in qs:
                code_holder.append(qs["code"][0])
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(
                    b"<h2 style='font-family:sans-serif;margin:40px'>Autenticacion exitosa. "
                    b"Podes cerrar esta tab.</h2>"
                )
            else:
                self.send_response(400); self.end_headers()
        def log_message(self, *_): pass

    server = http.server.HTTPServer(("localhost", 8080), _Handler)
    t = threading.Thread(target=server.handle_request, daemon=True)
    t.start()

    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id":     CLIENT_ID,
        "redirect_uri":  REDIRECT_URI,
        "scope":         SCOPE,
        "response_type": "code",
        "access_type":   "offline",
        "prompt":        "consent",
    })
    print("Abriendo browser para autenticacion...")
    webbrowser.open(url)
    t.join(timeout=120)

    if not code_holder:
        print("Timeout: no se recibio respuesta en 120 segundos.")
        sys.exit(1)

    tokens = _post_form(TOKEN_URL, {
        "code":          code_holder[0],
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri":  REDIRECT_URI,
        "grant_type":    "authorization_code",
    })
    if "refresh_token" not in tokens:
        print("Error al obtener tokens:", tokens)
        sys.exit(1)

    with open(TOKEN_FILE, "w") as f:
        json.dump({"refresh_token": tokens["refresh_token"]}, f)
    print(f"Token guardado en {TOKEN_FILE}")
    print("Setup completo. Ahora podes correr: python deploy_apps_script.py")


# ─────────────────────────────────────────────────────────────────────────────
def deploy():
    if SCRIPT_ID == "REPLACE_WITH_SCRIPT_ID":
        print("ERROR: Set SCRIPT_ID in deploy_config.py before deploying.")
        print("  1. Create a project at https://script.google.com")
        print("  2. Project Settings → Script ID → copy the value")
        sys.exit(1)

    access_token = _get_access_token()
    hdrs = {"Authorization": "Bearer " + access_token, "Content-Type": "application/json"}
    local_names  = {name for name, _, _ in LOCAL_FILES}

    # 1. GET contenido actual para preservar appsscript.json
    current  = _api("GET", f"{API_BASE}/{SCRIPT_ID}/content", hdrs)
    existing = {f["name"]: f for f in current.get("files", [])}

    # 2. Merge con archivos locales
    for name, ftype, path in LOCAL_FILES:
        with open(path, encoding="utf-8") as f:
            existing[name] = {"name": name, "type": ftype, "source": f.read()}

    result   = _api("PUT", f"{API_BASE}/{SCRIPT_ID}/content",   hdrs, {"files": list(existing.values())})
    deployed = [f["name"] for f in result.get("files", [])]
    print(f"Contenido actualizado — {len(deployed)} archivos:")
    for name in deployed:
        print(f"  {name}{' <- actualizado' if name in local_names else ''}")

    # 3. Crear nueva versión del HEAD
    ver = _api("POST", f"{API_BASE}/{SCRIPT_ID}/versions", hdrs, {"description": "deploy via script"})
    ver_num = ver["versionNumber"]
    print(f"Nueva versión creada: {ver_num}")

    if DEPLOYMENT_ID == "REPLACE_WITH_DEPLOYMENT_ID":
        print("DEPLOYMENT_ID not set. Create the Web App manually first:")
        print("  Apps Script > Deploy > New deployment > Type: Web App")
        print("  Execute as: Me — Access: Anyone with Google link")
        print("  Copy the Deployment ID to deploy_config.py and re-run.")
        return

    # 4. Actualizar el deployment existente a la nueva versión
    upd = _api("PUT", f"{API_BASE}/{SCRIPT_ID}/deployments/{DEPLOYMENT_ID}", hdrs, {
        "deploymentConfig": {
            "versionNumber":    ver_num,
            "manifestFileName": "appsscript",
            "description":      f"v{ver_num} — deploy via script",
        }
    })
    live_ver = upd.get("deploymentConfig", {}).get("versionNumber")
    print(f"Deployment actualizado -> version {live_ver}  OK")


# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if "--auth" in sys.argv:
        do_auth()
    else:
        deploy()
