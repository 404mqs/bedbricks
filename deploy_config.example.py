# deploy_config.py — copy this file, fill in your values, never commit it.
#
#   cp deploy_config.example.py deploy_config.py
#
# SCRIPT_ID:     script.google.com → your project → Project Settings → Script ID
# DEPLOYMENT_ID: Apps Script editor → Deploy → Manage deployments → copy ID
#                (leave as placeholder until after the first manual deployment)
#
# CLIENT_ID / CLIENT_SECRET: Google Cloud Console → APIs & Services → Credentials
#   → Create OAuth 2.0 Client ID → Application type: Desktop App
#   → Enable "Google Apps Script API" for your project
#   → Download JSON or copy the values below

SCRIPT_ID     = "your-script-id-here"
DEPLOYMENT_ID = "your-deployment-id-here"

CLIENT_ID     = "your-client-id.apps.googleusercontent.com"
CLIENT_SECRET = "your-client-secret"
