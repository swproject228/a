#!/usr/bin/env python3
"""Калькулятор удвоения денег: 1000 ₽ -> 2000 ₽ -> 4000 ₽ -> ...

Программа не умножает деньги сама по себе — такого не бывает. Она честно
считает, за какой срок сумма удвоится на вкладе или накопительном счёте
с ежемесячной капитализацией процентов и, по желанию, ежемесячными
пополнениями.

Запуск без параметров — программа задаст вопросы.
Запуск с параметрами, например:
    python3 doubler.py --start 1000 --rate 13 --topup 500 --doublings 6
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass
from datetime import date

MAX_YEARS = 100

MONTH_NAMES = [
    "январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
]


@dataclass
class Milestone:
    target: float       # сумма, которую хотели получить
    month: int          # через сколько месяцев она набралась
    balance: float      # сколько на счёте в этот месяц
    contributed: float  # сколько своих денег внесено (старт + пополнения)

    @property
    def interest(self) -> float:
        return self.balance - self.contributed


def simulate(
    start: float,
    annual_rate: float,
    monthly_topup: float = 0.0,
    doublings: int = 5,
    max_months: int = MAX_YEARS * 12,
) -> list[Milestone]:
    """Помесячно растит сумму и запоминает, когда она удваивается.

    Каждый месяц начисляются проценты (годовая ставка / 12), затем
    добавляется пополнение. Целевые суммы: start*2, start*4, start*8, ...
    """
    monthly_rate = annual_rate / 100 / 12
    balance = start
    contributed = start
    target = start * 2
    milestones: list[Milestone] = []

    for month in range(1, max_months + 1):
        balance = balance * (1 + monthly_rate) + monthly_topup
        contributed += monthly_topup
        # За один месяц можно перешагнуть сразу несколько целей
        # (например, при большом пополнении).
        while balance >= target and len(milestones) < doublings:
            milestones.append(Milestone(target, month, balance, contributed))
            target *= 2
        if len(milestones) >= doublings:
            break

    return milestones


def doubling_years(annual_rate: float) -> float | None:
    """Точный срок одного удвоения без пополнений, в годах."""
    if annual_rate <= 0:
        return None
    return math.log(2) / (12 * math.log(1 + annual_rate / 100 / 12))


def plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(n) % 100
    if 11 <= n <= 19:
        return many
    n %= 10
    if n == 1:
        return one
    if 2 <= n <= 4:
        return few
    return many


def format_money(amount: float) -> str:
    return f"{amount:,.0f}".replace(",", " ") + " ₽"


def format_duration(months: int) -> str:
    years, rest = divmod(months, 12)
    parts = []
    if years:
        parts.append(f"{years} {plural(years, 'год', 'года', 'лет')}")
    if rest or not years:
        parts.append(f"{rest} мес.")
    return " ".join(parts)


def month_after(today: date, months: int) -> str:
    index = today.month - 1 + months
    return f"{MONTH_NAMES[index % 12]} {today.year + index // 12}"


def parse_number(text: str) -> float:
    """Понимает «1 000», «13,5» и «13.5»."""
    cleaned = text.replace(" ", "").replace(" ", "").replace(",", ".")
    return float(cleaned)


def ask(question: str, default: float, minimum: float) -> float:
    while True:
        answer = input(f"{question} [{default:g}]: ").strip()
        if not answer:
            return default
        try:
            value = parse_number(answer)
        except ValueError:
            print("  Не понял число, попробуйте ещё раз.")
            continue
        if value < minimum:
            print(f"  Нужно число не меньше {minimum:g}.")
            continue
        return value


def print_report(
    start: float,
    rate: float,
    topup: float,
    doublings: int,
    inflation: float,
    today: date,
) -> None:
    print()
    print(f"Стартовая сумма: {format_money(start)}")
    print(f"Ставка:          {rate:g}% годовых, проценты капитализируются каждый месяц")
    print(f"Пополнение:      {format_money(topup)} в месяц")
    if inflation:
        print(f"Инфляция:        {inflation:g}% в год")

    years = doubling_years(rate)
    if years is not None:
        years_text = f"{years:.1f}".replace(".", ",")
        print(f"\nБез пополнений деньги удваиваются примерно за {years_text} года.")

    milestones = simulate(start, rate, topup, doublings)
    if not milestones:
        print(f"\nПри таких условиях сумма не удвоится даже за {MAX_YEARS} лет.")
        print("Нужна ставка больше нуля или ежемесячное пополнение.")
        return

    headers = ["Цель", "Срок", "Когда", "На счёте", "Своих денег", "Проценты"]
    if inflation:
        headers.append("В нынешних деньгах")

    rows = []
    for m in milestones:
        row = [
            format_money(m.target),
            format_duration(m.month),
            month_after(today, m.month),
            format_money(m.balance),
            format_money(m.contributed),
            format_money(m.interest),
        ]
        if inflation:
            real = m.balance / (1 + inflation / 100) ** (m.month / 12)
            row.append(format_money(real))
        rows.append(row)

    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]
    print()
    for line in [headers, ["-" * w for w in widths], *rows]:
        print("  ".join(c.ljust(w) for c, w in zip(line, widths)).rstrip())

    if len(milestones) < doublings:
        print(f"\nДальше за {MAX_YEARS} лет удвоиться не успеет.")

    print(
        "\nВажно: если кто-то обещает удвоить деньги за неделю или месяц — это"
        "\nпочти наверняка мошенники или финансовая пирамида. Вклады в банках"
        "\nс лицензией ЦБ застрахованы государством (АСВ) до 1,4 млн ₽."
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Считает, за сколько времени сумма удвоится на вкладе: "
        "1000 -> 2000 -> 4000 -> ... Без параметров задаёт вопросы."
    )
    parser.add_argument("--start", type=float, help="стартовая сумма, ₽ (по умолчанию 1000)")
    parser.add_argument("--rate", type=float, help="ставка, %% годовых (по умолчанию 13)")
    parser.add_argument("--topup", type=float, help="пополнение каждый месяц, ₽ (по умолчанию 0)")
    parser.add_argument("--doublings", type=int, help="сколько раз удвоить (по умолчанию 5)")
    parser.add_argument("--inflation", type=float, help="инфляция, %% в год (по умолчанию не учитывается)")
    args = parser.parse_args(argv)

    interactive = all(v is None for v in vars(args).values())
    if interactive:
        print("Калькулятор удвоения денег. Нажмите Enter, чтобы взять значение в скобках.\n")
        start = ask("С какой суммы начинаем, ₽", 1000, 1)
        rate = ask("Ставка по вкладу, % годовых", 13, 0)
        topup = ask("Сколько докладывать каждый месяц, ₽", 0, 0)
        doublings = int(ask("Сколько раз удвоить", 5, 1))
        inflation = ask("Инфляция, % в год (0 — не учитывать)", 0, 0)
    else:
        start = args.start if args.start is not None else 1000
        rate = args.rate if args.rate is not None else 13
        topup = args.topup if args.topup is not None else 0
        doublings = args.doublings if args.doublings is not None else 5
        inflation = args.inflation if args.inflation is not None else 0
        if start <= 0 or rate < 0 or topup < 0 or doublings < 1 or inflation < 0:
            parser.error("стартовая сумма и число удвоений должны быть больше нуля, "
                         "остальные значения — не меньше нуля")

    print_report(start, rate, topup, doublings, inflation, date.today())

    if interactive and sys.stdin.isatty():
        input("\nНажмите Enter, чтобы выйти...")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print()
