#!/usr/bin/env python3
"""Build the isolated HTTPS development client and account UI."""
import os,subprocess
from pathlib import Path
from dotenv import dotenv_values
root=Path(__file__).resolve().parents[2];host='https://space-dev-908123.entropydrop.com'
settings=dotenv_values(root/'entropydrop_backend/.env')
env={**os.environ,'VITE_SPACE_BASE_PATH':'/','VITE_API_BASE_URL':host+'/skin','VITE_SPACE_API_BASE_URL':host,'VITE_MAIN_SITE_ORIGIN':host,'VITE_SPACE_URL':host+'/','VITE_GOOGLE_CLIENT_ID':settings.get('GOOGLE_CLIENT_ID','')}
subprocess.run(['npm','exec','--workspace','@entropydrop/space','--','vite','build','--outDir','../.local/dev-domain/client'],cwd=root/'entropydrop_space',env=env,check=True)
subprocess.run(['npm','exec','--','vite','build','--outDir','../entropydrop_space/.local/dev-domain/main'],cwd=root/'entropydrop_frontend',env=env,check=True)
