# MatBoard

Ein digitales **Whiteboard** für die Zusammenarbeit im Team – in der Art von Miro: Ideen sammeln, Notizen schreiben, Aufgaben planen und Konzepte visuell darstellen, auf einer endlosen Fläche. Mehrere Personen arbeiten **gleichzeitig** an einem Board, jede Änderung erscheint in Echtzeit bei allen anderen.

![Ein Board](docs/images/board.png)

## Funktionen

- **Endlose Fläche** mit Zoom und Verschieben (Maus, Trackpad, Touch mit zwei Fingern), Hintergrund Punkte / Raster / Linien / leer.
- **Werkzeuge:** Haftnotizen, Text, Rechteck, Ellipse, Raute, Dreieck, **Verbindungen** (gerade, Kurve, Winkel, Pfeilspitzen, haften an Formen und folgen ihnen), Rahmen (nehmen ihren Inhalt mit), Stift, Bilder (Auswahl, Einfügen, Ziehen).
- **Bearbeiten:** Auswahl per Klick oder Rechteck, Verschieben, Skalieren, Drehen, Farben, Textgröße, Reihenfolge, Duplizieren, Kopieren / Einfügen, **Rückgängig / Wiederholen**, Tastaturkürzel (siehe *Über*).
- **Echtzeit:** Wer ist auf dem Board, Cursor mit Namen, Änderungen live (WebSocket). Gleichzeitige Änderungen am selben Objekt werden feldweise zusammengeführt.
- **Teilen:** Personen mit Konto als *Bearbeiter* oder *Betrachter* einladen (auf Wunsch mit E-Mail über MatSMTP), oder einen **Link** herausgeben (ansehen / bearbeiten, Gäste nennen einen Namen). Ein neuer Link macht den alten ungültig; Rechte werden sofort durchgesetzt, auch für offene Verbindungen.
- **Export:** PNG, SVG, JSON.
- **PWA:** installierbar (Android, iOS, Desktop), Safe Areas und Statusleiste abgestimmt, kein ungewolltes Zoomen. **Offline:** das zuletzt geladene Board bleibt sichtbar, Änderungen werden auf dem Gerät gesammelt und nach der Wiederverbindung abgeglichen.
- **Mattiverse:** Anmeldung über **MatIdentity**, E-Mails über **MatSMTP**, Plattform-Schnittstelle (`/api`) für Mattiverse.
- Oberfläche auf Deutsch und Englisch, hell / dunkel, Design **MatDesign** (MatUi).

| Boards | Teilen | Handy |
|---|---|---|
| ![Liste](docs/images/boards.png) | ![Link](docs/images/board-share.png) | ![Handy](docs/images/phone-board.png) |

## Starten

```bash
docker compose up -d
```

Dann **http://localhost:3945** öffnen. Das erste Konto, das sich registriert, ist der Administrator. Danach legt der Administrator Konten an (oder öffnet die Registrierung unter *Administration → System*).

Der Stack hat zwei Container (`web`, `db` mit PostgreSQL 17) und zwei Volumes (`web-data` für die Schlüssel der Sitzungen, `db-data` für die Datenbank). Es gibt **keine** Variablen, die man setzen muss. Optional (setzt Mattiverse, wenn es MatBoard installiert):

| Variable | Wirkung |
|---|---|
| `MATIDENTITY_AUTHORITY`, `MATIDENTITY_CLIENT_ID`, `MATIDENTITY_CLIENT_SECRET`, `MATIDENTITY_INTERNAL_URL` | Anmeldung über MatIdentity |
| `MATSMTP_HOST`, `MATSMTP_PORT`, `MATSMTP_USERNAME`, `MATSMTP_PASSWORD`, `MATSMTP_FROM`, `MATSMTP_TLS` | E-Mail über MatSMTP (ohne sie versendet MatBoard keine Mails) |
| `MAT_API_KEY` | Schlüssel der Plattform-Schnittstelle `/api/*` |

Hinter einem Reverse Proxy müssen **WebSockets** durchgereicht werden (`/live/boards/{id}/ws`) und `X-Forwarded-Proto` / `X-Forwarded-Host` gesetzt sein.

## Branches, Versionen, Images

| Branch | Version | Image | Compose |
|---|---|---|---|
| `main` | `<major>.<minor>.<build>-<datum>`, z. B. `0.1.42-20261031` | `ghcr.io/real-ttx/matboard:latest` | `docker-compose.yml` |
| `dev` | `nightly-<build>-<datum>` | `ghcr.io/real-ttx/matboard:nightly` | `docker-compose.dev.yml` (mit pgAdmin) |
| lokal | `local-<datum>` | `matboard:local` | `docker-compose.local.yml` (baut aus dem Ordner, mit pgAdmin) |

Die GitHub Action (`.github/workflows/build.yml`) baut, testet und veröffentlicht das Image (amd64 + arm64) für beide Branches. Die Build-Nummer ist die Nummer des Workflow-Laufs. Die Version steht links unten im Menü und führt zur *Über*-Seite.

## Entwickeln

```powershell
./scripts/redeploy.ps1          # baut den Container neu und startet den lokalen Stack: http://localhost:3945, pgAdmin http://localhost:3946
./scripts/redeploy.ps1 -Clean   # dasselbe mit leerer Datenbank
dotnet build MatBoard.slnx
dotnet test                     # mit MATBOARD_TEST_DB (PostgreSQL, Recht zum Anlegen von Datenbanken) laufen auch die Datenbank-Tests
```

Technik: ASP.NET Core 10, Razor Pages, EF Core + PostgreSQL, MatUi (CSS + ein Skript, ohne Build-Schritt), Canvas als SVG mit eigenem JavaScript (`wwwroot/js/board-*.js`), WebSocket ohne zusätzliche Bibliothek. Mehr in [CLAUDE.md](CLAUDE.md).
