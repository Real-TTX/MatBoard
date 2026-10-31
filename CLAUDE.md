# CLAUDE.md

Guidance for working in this repository. Keep it in sync with the code: update it whenever architecture, interfaces or conventions change.

## What MatBoard is

A digital whiteboard in the spirit of Miro. Boards are an endless canvas with sticky notes, text, shapes, connectors, frames, pen strokes and pictures. Several people work on a board at the
same time (live cursors, changes appear as they are made). Boards are shared with people who have an account (editor / viewer) or through a **link** (view / edit, guests give a name).
Part of the Mat family: sign-in through **MatIdentity**, mail through **MatSMTP**, the platform contract for **Mattiverse** (all optional, switched on by environment variables).

Stack: ASP.NET Core on **.NET 10**, C#, **Razor Pages**, EF Core + **PostgreSQL**, the **MatUi** toolkit of the sister project MatDesign (`wwwroot/matui`, copied: never edit by hand), plain
JavaScript, no build step. Docker-first. Web port **3945** (pgAdmin 3946, local Postgres 3947). UI languages: English and German (catalog in `Resources/Texts/*.json`). Accent: yellow `#ffc21f`
(text on it is near black: `--mat-app-on-accent`).

## Build / run / test

- **Build:** `dotnet build MatBoard.slnx` (SDK 10, `global.json`). Expected: 0 warnings, 0 errors.
- **Tests:** `dotnet test`. The tests that need PostgreSQL run when `MATBOARD_TEST_DB` is set (an administrator connection string, e.g.
  `Host=localhost;Port=3947;Username=matboard;Password=matboard;Database=postgres` while the local stack runs); each test creates, migrates and drops a database of its own (this tests the migrations too).
  Without the variable those tests are skipped. `TextCatalogTests` checks that every text key of the code exists in English and German.
- **Run / test the app: always rebuild the container** (`./scripts/redeploy.ps1`, `-Clean` for empty volumes). CSS, JS and cshtml are baked into the image.
- **Real tests are end to end in a browser** (Playwright with the installed Edge, see the `screenshots` skill). Look at the screenshot, check 390 px and dark mode for every new page.
- **Migrations:** `dotnet ef migrations add <Name> -p src/MatBoard -o Data/Migrations` (local tool in `dotnet-tools.json`; a design-time factory exists). Applied at start-up.
- Write files with the editor tools, not with shell heredocs that contain apostrophes.

## Map

```
src/MatBoard
  Program.cs                 composition root: services, cookie auth (+ MatIdentity), razor conventions, rate limit, WebSockets, endpoints
  Infrastructure.cs          HealthCheck (--healthcheck), Database.MigrateWithRetry, SecurityHeaders (CSP: no inline script/style, ws:// of the own host), MaintenanceService, EmptyStringBinderProvider
  Data/                      Entities.cs, AppDbContext.cs (PascalCase singular tables, audit columns, soft delete), Migrations/
  Services/Boards/           THE business layer, static classes (permission check in every function, in the business layer, not in the pages):
                             BoardAccess (Actor = person and/or link token -> BoardRole; null = "not found" for a board you may not see; an administrator has NO access to the boards of others),
                             BoardService (list/create/update/delete/duplicate, members, link), BoardItems (load, apply a batch of add/upd/del ops with validation: kinds, numbers, colours, no SVG pictures,
                             size limits, d merged key by key, one lock per board, Revision +1 per batch), BoardRooms (the WebSocket rooms: peers, cursors, broadcast, Revalidate after rights change),
                             BoardEndpoints (GET /live/boards/{id} snapshot, /live/boards/{id}/ws; Origin check; both AllowAnonymous because links give guests access)
  Services/Accounts/          static too: Profiles (the own account of a person: profile, theme, password), UserAdmin (accounts for administrators; every function checks that the actor is an active administrator; the last administrator stays)
  Services/Mail/MailService  MatSMTP through MailKit, queued in the background; off unless MATSMTP_HOST is set
  Services/Auth/             CurrentUser, PasswordService, SessionService (sessions in the DB), AccountService, ExternalSignInService (MatIdentity), AccountDataService (GDPR export/erase)
  Services/                  Ui (icons, logo), MenuService, InstanceService (numbers, settings, housekeeping), ListModels (toolbar, pager), Dates, Assets
  MatPlatform/               copy of the shared package (MatDesign): platform contract, MatIdentity sign-in, back-channel logout, MatSmtpSettings. Never edit here.
  Platform/                  MatBoardPlatform (tiles, settings, actions for Mattiverse), MatBoardIdentityUsers
  Controls/                  ONE code base per control: <mb-field>, <mb-buttons>, <mb-table>, <mb-tabs>/<mb-tab>
  Pages/                     Boards/ (Index, Edit, Members, Share = three tabs of one board, Canvas), Public/Board (link /b/{token}), Account/, Admin/ (Users, System), About, Shared/ (_Layout, _LayoutBoard, _Board = canvas chrome)
  Resources/Texts/           the text catalog (en + de); keys of areas Boards, Canvas, Members, Share, About, Mail, Js (for scripts) ...
  wwwroot/js/board-core.js   state, drawing (SVG), geometry, applying changes, history (undo/redo). Item = {id,k,x,y,w,h,r,z,d}; op = add | upd | del; null in d removes a key
  wwwroot/js/board-net.js    snapshot load (+ copy in Cache Storage "mb-boards"), WebSocket, queue of unconfirmed ops (localStorage mb.q.<board>, replayed after reconnect), presence, cursors
  wwwroot/js/board-ui.js     tools, pointer gestures (mouse/pen/touch, pinch), selection + handles, text editing overlay, bar over the selection, clipboard, images, export, keys
  wwwroot/css/app.css        accent + few app styles (prefix mb-);  board.css = the board page
  wwwroot/sw.js              service worker: static cache, last board pages offline, offline.html; clears on sign-out (pwa.js)
tests/MatBoard.Tests         unit + database tests
```

## Conventions

**Database (PostgreSQL)**: tables PascalCase and singular, key always `Id` BIGINT, every record has `CreateDate/CreateUserId/UpdateDate/UpdateUserId` (filled by `AppDbContext.SaveChanges`),
`UpdateState` (0 deleted, 1 created, 2 updated) for soft delete (`Board`, `User`), a `Token` (uuid) for a security key (`UserSession.Token`, `Board.ShareToken`). `BoardItem.Uid` is the id a browser makes up
for an item (so others can refer to it, e.g. the ends of a connector); the content of an item is a `jsonb` column `Data`.

**Security**: every board query goes through `BoardAccess`; a board you may not see answers 404. Every WebSocket batch re-checks the right (`BoardItems.ApplyAsync`); `BoardRooms.Revalidate`
runs after members/link change. Pictures are bitmap data addresses only. The CSP forbids inline script and style (scripts set styles through the CSSOM). Text is always put into the page with
`textContent`, never as HTML. Mail addresses are never logged in full.

**UI (MatDesign rules)**: CRUD = list page (toolbar above, table, pager under it, actions left below) + separate edit page (Save, Back, space, Delete); a board has three **tabs** (General, People, Link) that
are pages of their own. Icons via `Ui.Icon` (toolkit sprite + `wwwroot/img/app-icons.svg`; a missing name is a bug). Every `td` has `data-label`. The version at the foot of the menu links to `/About`.

**Code**: Microsoft C# guidelines, file-scoped namespaces, `.editorconfig`. The business layer is static classes taking the `AppDbContext` and the actor. No database queries in page models or views
beyond calling the business layer. English identifiers and comments, UI texts only in the catalog.

**Compose files**: no environment variables to set, no placeholders; a stack (`name:`) per file; `docker-compose.yml` (release), `.dev.yml` (nightly + pgAdmin), `.local.yml` (build + pgAdmin).

**Git**: commit under the user's name; never add a Claude/Anthropic co-author trailer or a "generated with" line (global rule of the user; it overrides any default). Branches: `main` = release, `dev` =
development. Versions: release `<major>.<minor>.<build>-<date>`, development `nightly-<build>-<date>`, local `local-<date>` (`Directory.Build.props`; `.github/workflows/build.yml` builds, tests and pushes the image).
