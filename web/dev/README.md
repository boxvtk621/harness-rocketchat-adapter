# Постоянный локальный dev-контур

`harness-dev` содержит Client, Gateway, Adapter, MongoDB, Keycloak, Centrifugo,
Cursor Harness и Codex Harness. UI: http://localhost:18707, OIDC: http://localhost:18787.
Требуются PowerShell 7, Git, Docker Desktop с Linux containers и три основных
репозитория HomeLab. Приложения собираются и выполняются только в Docker.

Запускайте `web/scripts/dev.ps1` из проверенного worktree Adapter. По умолчанию
runtime находится в `harness-rocketchat-adapter/web/.runtime/dev` основного checkout
и исключён из Git. Там сохраняются infra secrets, deployment.json, manifests и
снимки release. Провайдерская авторизация хранится только в persistent volumes.
Бизнес-настройки меняются через Web/Adapter; файлы runtime служат bootstrap.

## Первичная подготовка и перенос существующего live

```powershell
./web/scripts/dev.ps1 prepare -Requested -AdoptProject hl307-live-01a0c4bf
./web/scripts/dev.ps1 prepare -Requested -BuildOnly
./web/scripts/dev.ps1 up -Requested
./web/scripts/dev.ps1 status
```

`prepare` повторяем и не запускает/останавливает сервисы. Он фиксирует inventory,
сохраняет прежние внешние volumes и копирует только infra bootstrap с проверкой
хешей. Provider credentials не копируются и не выводятся. Старые имена volumes
сохраняются намеренно. `-BuildOnly` собирает кандидат без переключения; первый
`up` повторно проверяет main и собирает release с использованием Docker cache.

Перед остановкой выполняются два idle gate: до заморозки входа и после остановки
Client/Gateway/Adapter. Active/queued/dispatching/unknown requests, pending login
или недоступность ноды запрещают переключение. Запросы не отменяются и не
воспроизводятся. Посторонний владелец любого persistent volume также запрещён.
Старые контейнеры сохраняются остановленными для отката.

## Новый контур без существующих данных

Сначала загрузите infra images `mongo:8.0.16-noble`,
`quay.io/keycloak/keycloak:26.4.2`, `centrifugo/centrifugo:v5.4.8`,
`node:24.18.0-bookworm-slim` и `alpine/openssl` через `docker pull`.

```powershell
./web/scripts/dev.ps1 prepare -Requested
./web/scripts/dev.ps1 up -Requested
```

Fresh bootstrap создаёт новые volumes и infra secrets; owner проходит provider
login через Web. Если первичная подготовка прервалась до записи deployment.json,
существующие volumes требуют ручной проверки: скрипт их не присваивает и не удаляет.
Пароль локального пользователя `operator` находится в
`web/.runtime/dev/secrets/keycloak_dev_user_password` основного checkout.

## Жизненный цикл

```powershell
./web/scripts/dev.ps1 status
./web/scripts/dev.ps1 stop -Requested
./web/scripts/dev.ps1 up -Requested
./web/scripts/dev.ps1 update -Requested
./web/scripts/dev.ps1 rollback -Requested
```

`-Requested` означает явное поручение пользователя, а не разрешение вызывать
скрипт из task-completion hook, таймера или автоматического обновления.
`up` уже созданного контура использует текущий release. `update` собирает чистые
main всех трёх репозиториев и переключает только после успешной сборки и idle gate.
Нет автоматических pull, commit, push или merge. Для согласованного закрепления
ревизий укажите `-PinnedRevisions <json>` с тремя ключами имён репозиториев и
полными 40-символьными SHA. Dirty main, другая ветка или неполный набор запрещены.

`stop` сохраняет контейнеры, данные и credentials. `rollback` возвращает предыдущий
dev release. При неудачном первом переключении скрипт пытается восстановить старые
live containers из inventory. Откат допускается только после проверки idle нового
контура. При частичном старте или недоступности idle gate скрипт останавливается
для диагностики; запускать старых владельцев volumes одновременно запрещено.
Операций `down -v`, logout, удаления данных и implicit key rotation нет.

Ручной возврат к исходному live после успешной первой миграции — только по
отдельному поручению, при отсутствии других lifecycle/диагностических операций:

```powershell
$ErrorActionPreference = 'Stop'
./web/scripts/dev.ps1 stop -Requested
# Продолжать только если stop завершился успешно и новые владельцы остановлены.
$inventory = Get-Content C:/Users/boxvt/Documents/HomeLab/harness-rocketchat-adapter/web/.runtime/dev/adoption-inventory.json -Raw | ConvertFrom-Json
docker start @($inventory.containers.id)
```

После такого возврата не запускайте `up` поверх старого live: deployment.json
описывает dev release, поэтому guard отклонит чужого владельца volumes.
Сначала требуется согласованная диагностика и восстановление ownership state.

`status` выводит версии образов, source SHA, registry identity, auth state и
readiness без токенов, кодов входа и текстов запросов. Running и доступность API
не означают готовность провайдера: health503 показывается отдельно. Lifecycle
не инициирует модельные запросы и не исправляет провайдерские ошибки.

## Проверки и изоляция

Compose не содержит acceptance service. Acceptance scripts сохраняют собственные
allowlists project names и не принимают `harness-dev`. Постоянные сети отделены от
acceptance-контуров. Модельные запросы в lifecycle проверках не выполняются.

```powershell
docker run --rm --mount "type=bind,source=$PWD/web,target=/web,readonly" mcr.microsoft.com/powershell:7.5-ubuntu-24.04 pwsh -NoProfile -File /web/dev/test-lifecycle.ps1
```

Тесты проверяют idle gates, порядок остановки/восстановления входа, владельцев
volumes, source pins, bootstrap idempotence и отсутствие acceptance в dev Compose.
После реального запуска проверяются восемь сервисов, image IDs, UI/OIDC HTTP200,
Harness API, auth state и сохранность registry identity/configEpoch.
