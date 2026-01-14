# Binance Margin Borrow Alert Bot

Telegram-бот на Node.js (Telegraf), который каждые несколько минут запрашивает статистику маржинальных займов Binance, считает метрики и отправляет ALERT при заданных условиях.

## Требования

- Node.js 18+
- Telegram Bot Token
- CHAT_ID (ID чата/канала)

## Установка

```bash
npm install
```

## Настройка

Скопируйте пример окружения и заполните значения:

```bash
cp .env.example .env
```

Переменные:

- `BOT_TOKEN` — токен Telegram-бота.
- `CHAT_ID` — ID чата/канала, куда отправлять сообщения.
- `SCAN_INTERVAL_MINUTES` — интервал сканирования (минуты).

## Запуск

```bash
npm start
```

## Команды

- `/stats` — выводит ТОП-10 токенов по BOR.D в виде таблицы.
