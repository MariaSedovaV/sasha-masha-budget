"""Перечитать Excel из папки проекта, обновить снимки графиков.

Запуск: python3 refresh_from_excel.py [--publish]
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
DOCS_STATIC = ROOT / "docs" / "static"
SITE_STATIC = SITE / "static"
STATIC_FILES = ("index.html", "app.js", "styles.css", "sync.js", "assistant.js")


def _log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def refresh() -> dict:
    sys.path.insert(0, str(SITE))
    from engine.db import get_meta, init_db, set_meta
    from engine.excel_fcf import clear_excel_cache
    from engine.excel_sync import ExcelStructureError, excel_is_open, validate_excel
    from engine.seed_excel import find_excel, seed_from_excel
    from export_snapshot import main as export_snapshot

    excel = find_excel()
    if not excel:
        raise FileNotFoundError("В папке проекта нет файла *Бюджет 2026.xlsx")
    _log(f"Excel: {excel.name}")
    if excel_is_open(excel):
        raise PermissionError("Excel открыт — закройте файл и повторите обновление")
    try:
        validate_excel(excel)
    except ExcelStructureError as exc:
        conn = init_db()
        set_meta(conn, "structure_ok", "0")
        set_meta(conn, "structure_error", str(exc))
        conn.commit()
        conn.close()
        raise
    clear_excel_cache()
    conn = init_db()
    seed_from_excel(conn, excel)
    closed = get_meta(conn, "closed_month")
    until = get_meta(conn, "fact_until")
    updated = get_meta(conn, "updated_at")
    conn.close()
    export_snapshot(also_docs=True)
    for name in STATIC_FILES:
        src = SITE_STATIC / name
        if src.exists():
            shutil.copy2(src, DOCS_STATIC / name)
            if name == "index.html":
                shutil.copy2(src, ROOT / "docs" / "index.html")
    _log(f"закрытый месяц={closed}, факт до={until}, обновлено={updated}")
    return {
        "excel": excel.name,
        "closed_month": closed,
        "fact_until": until,
        "updated_at": updated,
    }


def publish(message: str) -> None:
    env = os.environ.copy()
    env.setdefault("GIT_AUTHOR_NAME", "MariaSedovaV")
    env.setdefault("GIT_AUTHOR_EMAIL", "MariaSedovaV@users.noreply.github.com")
    env.setdefault("GIT_COMMITTER_NAME", env["GIT_AUTHOR_NAME"])
    env.setdefault("GIT_COMMITTER_EMAIL", env["GIT_AUTHOR_EMAIL"])
    subprocess.run(
        ["git", "add", "docs/index.html", "docs/static", "site/static/snapshot"],
        cwd=ROOT,
        check=True,
        env=env,
    )
    status = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT, env=env)
    if status.returncode == 0:
        _log("Нет изменений для публикации")
        return
    subprocess.run(["git", "commit", "-m", message], cwd=ROOT, check=True, env=env)
    subprocess.run(["git", "push", "origin", "HEAD"], cwd=ROOT, check=True, env=env)
    _log("Опубликовано в GitHub Pages")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--publish", action="store_true", help="commit+push снимков в docs/ для GitHub Pages")
    args = parser.parse_args()
    info = refresh()
    if args.publish:
        publish(
            f"Обновить графики из {info['excel']} "
            f"(факт до месяца {info['fact_until']})."
        )


if __name__ == "__main__":
    main()
