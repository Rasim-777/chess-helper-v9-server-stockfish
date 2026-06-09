Chess Profi Helper v9 Server Stockfish

Это серверный вариант:
- Stockfish работает на сервере, не на iPhone.
- iPhone только отправляет FEN и получает лучший ход.
- Это должно быть стабильнее, чем браузерный Stockfish.
- Есть 3 лучших хода, оценка, depth и линия.

ВАЖНО:
Это НЕ Netlify Drop. Это Docker-сервер.
Загрузи файлы на GitHub и разверни на Render как Web Service с Language = Docker.

Коротко:
1. Создай GitHub репозиторий.
2. Загрузи туда все файлы из папки chess-helper-v9-server-stockfish.
3. На Render создай New Web Service.
4. Подключи GitHub.
5. Language: Docker.
6. Deploy.
7. Открой Render-ссылку на iPhone.
8. Сверху должно быть: Server Stockfish: готов.

Если бесплатный Render заснул, первая загрузка может идти 30–60 секунд.
