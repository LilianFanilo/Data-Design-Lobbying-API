import os, re, sqlite3
import psycopg
from dotenv import load_dotenv

load_dotenv()
src = sqlite3.connect("agora.db")
dst = psycopg.connect(os.environ["SUPABASE_DB_URL"])

# Identifiants à forcer en entier partout (sinon les jointures échouent en PostgreSQL)
ID_COLS = {"representants_id", "action_representation_interet_id", "activite_id", "exercices_id"}

def snake(name):
    # dateCessation -> date_cessation (PostgreSQL préfère les noms en minuscules)
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name).lower()

def to_int(v):
    try: return int(str(v).strip())
    except (TypeError, ValueError): return None

def to_float(v):
    try: return float(v)
    except (TypeError, ValueError): return None

tables = [r[0] for r in src.execute(
    "SELECT name FROM sqlite_master WHERE type='table' "
    "AND name NOT LIKE '%fts%' AND name NOT LIKE 'sqlite_%'")]

with dst.cursor() as cur:
    for t in tables:
        cols, convs = [], []
        for _, name, typ, *_ in src.execute(f'PRAGMA table_info("{t}")'):
            if name in ID_COLS or typ.upper() == "INTEGER":
                cols.append((snake(name), "bigint")); convs.append(to_int)
            elif typ.upper() == "REAL":
                cols.append((snake(name), "double precision")); convs.append(to_float)
            else:
                cols.append((snake(name), "text")); convs.append(None)

        cur.execute(f"DROP TABLE IF EXISTS {t}")
        cur.execute(f"CREATE TABLE {t} ({', '.join(f'{n} {ty}' for n, ty in cols)})")

        n_rows = n_invalides = 0
        col_list = ", ".join(n for n, _ in cols)
        with cur.copy(f"COPY {t} ({col_list}) FROM STDIN") as copy:
            for row in src.execute(f'SELECT * FROM "{t}"'):
                out = []
                for v, conv in zip(row, convs):
                    if conv:
                        c = conv(v)
                        if c is None and v not in (None, ""):
                            n_invalides += 1
                        out.append(c)
                    else:
                        out.append(v)
                copy.write_row(out)
                n_rows += 1

        # Recrée les mêmes index que dans SQLite
        for idx in src.execute(f'PRAGMA index_list("{t}")').fetchall():
            idx_cols = [snake(r[2]) for r in src.execute(f'PRAGMA index_info("{idx[1]}")')]
            cur.execute(f"CREATE INDEX ON {t} ({', '.join(idx_cols)})")

        # Sécurité : lecture publique autorisée, écriture interdite
        cur.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        cur.execute(f'CREATE POLICY "lecture publique" ON {t} FOR SELECT TO anon USING (true)')

        print(f"{t}: {n_rows} lignes, {n_invalides} identifiants invalides mis à NULL")

dst.commit()
print("Migration terminée")
