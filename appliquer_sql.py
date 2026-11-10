"""Exécute un fichier SQL sur la base Supabase (adresse lue dans .env).

Usage : python appliquer_sql.py sql/exploration.sql
"""
import os, sys, time
import psycopg
from dotenv import load_dotenv

load_dotenv()
fichier = sys.argv[1] if len(sys.argv) > 1 else "sql/exploration.sql"
sql = open(fichier, encoding="utf-8").read()

debut = time.time()
with psycopg.connect(os.environ["SUPABASE_DB_URL"], prepare_threshold=None) as conn:
    conn.execute("set statement_timeout = 0")   # la construction peut prendre une minute
    conn.execute(sql)
print(f"{fichier} appliqué en {time.time() - debut:.0f} s")
