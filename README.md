# Акцепт-2 — B2B Landing Page

Федеральный поставщик металлопроката. Сайт на Astro с двуязычностью RU/EN.

## Структура

- `/` — русская версия
- `/en/` — английская версия
- `/privacy` — политика конфиденциальности
- `/terms` — пользовательское соглашение

## Запуск

```bash
npm install
npm run dev
```

## Деплой

Push в `main` → GitHub Actions автоматически деплоит на Pages. 
сайт https://acceptmetall.ru/

## Заявки с сайта

Формы требуют отдельного Node24 API с постоянным хранилищем и SMTP. GitHub Pages
не может выполнять этот обработчик. Полная настройка, переменные, безопасный
доступ к заказам и проверка доставки: [docs/ORDER-SERVICE.md](docs/ORDER-SERVICE.md).

```sh
npm ci
npm test
ASTRO_TELEMETRY_DISABLED=1 npm run build
npm audit --audit-level=low
```

Сервер запускается из корня с защищёнными переменными окружения:
`node --env-file=/etc/acceptmetall/orders.env server/index.mjs`.
Для публикации на Pages задайте repository variable `PUBLIC_ORDER_API_URL` —
полный HTTPS адрес обработчика `/api/orders`, без секретов.
