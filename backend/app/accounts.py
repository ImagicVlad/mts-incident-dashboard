"""Local account database and operator-only provisioning command."""

import argparse
import getpass
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from typing import Literal

from argon2 import PasswordHasher
from pydantic import BaseModel, ConfigDict

from .config import Settings

Role = Literal["coordinator", "executor"]


class Profile(BaseModel):
    model_config = ConfigDict(frozen=True)
    login: str
    displayName: str
    role: Role


class Accounts:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS accounts (
                    login TEXT PRIMARY KEY NOT NULL,
                    display_name TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('coordinator', 'executor')),
                    password_hash TEXT NOT NULL
                )
            """)

    def create(self, login: str, display_name: str, role: Role, password: str) -> Profile:
        profile = Profile(login=login.strip().casefold(), displayName=display_name.strip(), role=role)
        if not 1 <= len(profile.login) <= 128 or not profile.displayName:
            raise ValueError("Укажите логин длиной до 128 символов и имя для отображения.")
        if not password.strip() or len(password) > 256:
            raise ValueError("Укажите непустой пароль длиной до 256 символов.")
        password_hash = PasswordHasher().hash(password)
        try:
            with closing(sqlite3.connect(self.path)) as db, db:
                db.execute("INSERT INTO accounts(login,display_name,role,password_hash) VALUES(?,?,?,?)",
                           (profile.login, profile.displayName, profile.role, password_hash))
        except sqlite3.IntegrityError as exc:
            raise ValueError("Этот логин уже занят.") from exc
        return profile

    def credentials(self, login: str) -> tuple[Profile, str] | None:
        with closing(sqlite3.connect(self.path)) as db:
            row = db.execute("SELECT login,display_name,role,password_hash FROM accounts WHERE login=?",
                             (login.strip().casefold(),)).fetchone()
        if row is None:
            return None
        return Profile(login=row[0], displayName=row[1], role=row[2]), row[3]


def main():
    parser = argparse.ArgumentParser(description="Управление аккаунтами пульта")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="Создать аккаунт")
    create.add_argument("--login", required=True)
    create.add_argument("--display-name", required=True)
    create.add_argument("--role", choices=["coordinator", "executor"], required=True)
    create.add_argument("--password-stdin", action="store_true", help="Прочитать одну строку из stdin")
    args = parser.parse_args()
    password = sys.stdin.readline().rstrip("\r\n") if args.password_stdin else getpass.getpass("Пароль: ")
    try:
        profile = Accounts(Settings().accounts_path).create(args.login, args.display_name, args.role, password)
    except ValueError as exc:
        parser.exit(1, f"{exc}\n")
    print(f"Создан аккаунт {profile.login} ({profile.role})")


if __name__ == "__main__":
    main()
