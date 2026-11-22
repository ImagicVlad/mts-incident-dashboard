"""Find evidence for possible incident links in the current chat snapshot."""

import re
from collections import Counter
from dataclasses import dataclass
from heapq import nsmallest
from itertools import combinations

from .domain import OPEN
from .similar_cases import symptoms, terms


# Exclude stock registration language so repeated templates cannot establish a link.
_GENERIC = set("""
автоматически анализ аномалия в работе выполняется выполнять выявлена деградация диагностика
для жалуются зафиксирован зафиксирована зафиксировано зарегистрировано инцидент инцидента
клиенты компонент на необходим необходима неисправность неполадка нестабильно обнаружен
обнаружена обнаружено оборудование обращения отклонение отключение отказ ошибка ошибки
перестал пользователей пользователи после причина проблема проблемы происходит работает работы
сбой сбои своими свои сервис сервиса сервисе система системы системе событие статус требуется
устранение функции это при его под без нет есть между этом указан указано
авария недоступен недоступна недоступно доступность недоступность возникновения
ситуация зарегистрирован зарегистрирована мониторинг контроля проверка источник данных
часть приходит поддержка работают необходимы обратились выполняет заявленные характеристики
incident problem service system error failure failed the and for with from detected
""".split())
_MISSING = {"", "-", "—", "?", "нет", "не указан", "не указано", "неизвестно", "unknown", "n/a"}


def _label(value):
    label = " ".join((value or "").split()).casefold().replace("ё", "е")
    return "" if label in _MISSING else label


@dataclass
class _Record:
    row: dict
    product: str
    service: str
    heading: set[str]
    words: set[str]
    phrases: set[tuple[str, str]]

    @classmethod
    def read(cls, row):
        product, service = (_label(row.get(key)) for key in ("productName", "service"))
        fields = symptoms(row)
        excluded = terms(f"{product} {service}") | _GENERIC
        heading = terms(fields["header"]) - excluded
        words = {w for w in terms(" ".join(fields.values())) - excluded if not w.isdecimal()}
        phrases = set()
        for text in fields.values():
            tokens = re.findall(r"[^\W_]+", text.casefold().replace("ё", "е"))
            phrases.update((a, b) for a, b in zip(tokens, tokens[1:]) if a in words and b in words and a != b)
        return cls(row, product, service, heading, words, phrases)


def related_pairs(rows: list[dict], focus_ids: set[str]) -> list[dict]:
    """Return up to five hypotheses, preserving IDs and only citing observed overlap."""
    by_id = {row["id"]: _Record.read(row) for row in rows if row.get("id")}
    focused = {value.casefold() for value in focus_ids}
    records = [by_id[key] for key in sorted(by_id)]
    frequencies = Counter(word for record in records for word in record.words)
    # Ignore language that recurs widely across otherwise unrelated records.
    max_frequency = max(2, len(records) // 4)

    def ranked():
        targets = [r for r in records if r.row["id"].casefold() in focused]
        if len(focused) == 1:
            pairs = ((anchor, r) for anchor in targets for r in records if anchor is not r)
        else:
            pairs = combinations(targets if focused else records, 2)
        for left, right in pairs:
            same_product = bool(left.product and left.product == right.product)
            same_service = (same_product and bool(left.service and left.service == right.service)
                            and bool(terms(left.service) - terms(left.product) - _GENERIC))
            shared = {word for word in left.words & right.words if frequencies[word] <= max_frequency}
            in_titles = shared & left.heading & right.heading
            # A single word such as "очередь" can describe unrelated systems.
            phrases = (pair for pair in left.phrases & right.phrases if pair[0] in shared and pair[1] in shared)
            phrase = min(phrases, key=lambda pair: (-len(in_titles.intersection(pair)),
                                                     frequencies[pair[0]] + frequencies[pair[1]], pair),
                         default=None)
            code = any(re.search(r"[a-zа-я]", w) and re.search(r"\d", w) for w in in_titles)
            if not (same_service or code or phrase or (same_product and in_titles)):
                continue
            evidence = []
            if same_product:
                evidence.append(f"Совпадает название продукта «{left.row['productName'][:160]}».")
            if same_service:
                evidence.append(f"Совпадает название сервиса «{left.row['service'][:160]}».")
            if phrase:
                evidence.append(f"В обеих карточках встречается сочетание «{' '.join(phrase)[:160]}».")
            elif in_titles:
                matched = sorted(in_titles, key=lambda w: (frequencies[w], w))[:3]
                evidence.append("Общие слова в заголовках — " +
                                ", ".join(f"«{w[:80]}»" for w in matched) + ".")
            ids = [left.row["id"], right.row["id"]]
            titles = [(r.row.get("header") or r.row["id"])[:200] for r in (left, right)]
            active_count = sum(r.row.get("stateEnum") in OPEN for r in (left, right))
            rank = (-bool(in_titles), -same_service, -min(3, len(in_titles)), -active_count,
                    -min(3, len(shared)), *ids)
            yield rank, {"ids": ids, "titles": titles, "evidence": evidence}

    return [pair for _, pair in nsmallest(5, ranked(), key=lambda candidate: candidate[0])]
