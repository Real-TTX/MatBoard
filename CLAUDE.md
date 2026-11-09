# CLAUDE.md

Guidance for working in this repository. Keep it in sync with the code: update it whenever architecture, interfaces or conventions change.

## What MatBoard is

A digital whiteboard in the spirit of Miro. Boards are an endless canvas with sticky notes, text, shapes, connectors, frames, pen strokes, pictures, comments (pins with a thread) and stamps. Several people work on a board at the
same time (live cursors, changes appear as they are made). Boards are shared with people who have an account (editor / viewer) or through a **link** (view / edit, guests give a name).
Part of the Mat family on **MatPlatform 2.2** (platform contract 2, the Mat app model, MatDesign `docs/APP-MODEL.md`): MatBoard **consumes** `identity.oidc` (sign-in through
**MatIdentity**) and `mail.smtp` (mail through **MatSMTP**), both optional and set by their environment variables; it provides nothing and uses no other app. A broker
(**Mattiverse**) passes the variables; *Administration → Connections* (`<mat-connections />`) shows them. It **contributes** the launcher MatBoard (quick actions New board,
My boards, Shared with me) and two admin widgets (Boards, Active users) to a shell. MatBoard works without any of the variables.

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
                             size limits, comment threads, d merged key by key, a locked item (d.lock) only accepts being unlocked, one lock per board, Revision +1 per batch), BoardRooms (the WebSocket rooms: peers, cursors, views for following, summon (editors only), broadcast, Revalidate after rights change),
                             BoardEndpoints (GET /live/boards/{id} snapshot, /live/boards/{id}/ws; Origin check; both AllowAnonymous because links give guests access)
  Services/Accounts/          static too: Profiles (the own account of a person: profile, theme, password), UserAdmin (accounts for administrators; every function checks that the actor is an active administrator; the last administrator stays)
  Services/Mail/MailService  MatSMTP through MailKit, queued in the background; off unless MATSMTP_HOST is set
  Services/Auth/             CurrentUser, PasswordService, SessionService (sessions in the DB), AccountService, ExternalSignInService (MatIdentity), AccountDataService (GDPR export/erase)
  Services/                  Ui (icons, logo), MenuService, InstanceService (numbers, settings (the public address in force: MAT_PUBLIC_URL ?? stored), housekeeping), ListModels (toolbar, pager), Dates, Assets
  MatPlatform/               copy of the shared package (MatDesign, 2.2.1; tools/matplatform-copy.js): platform contract 2, bindings (MatBindings, the store in
                             /data/matplatform/bindings.json), the Connections area (<mat-connections />), MatIdentity sign-in, back-channel logout, MatSmtpSettings,
                             MAT_FRAME_ANCESTORS. Never edit here.
  Platform/                  MatBoardPlatform (the description: tiles, settings, actions, consumes identity.oidc + mail.smtp, launcher MatBoard + quick actions,
                             admin widgets boards/users; publicUrl fixed while MAT_PUBLIC_URL is set), MatBoardIdentityUsers
  Controls/                  ONE code base per control: <mb-field>, <mb-buttons>, <mb-table>, <mb-tabs>/<mb-tab>
  Pages/                     Boards/ (Index, Edit, Members, Share = three tabs of one board, Canvas), Public/Board (link /b/{token}), Account/, Admin/ (Users,
                             Connections (<mat-connections />), System (the public address read-only while MAT_PUBLIC_URL is set)), About, Shared/ (_Layout, _LayoutBoard, _Board = canvas chrome)
  Resources/Texts/           the text catalog (en + de); keys of areas Boards, Canvas, Members, Share, About, Mail, Js (for scripts) ...
  wwwroot/js/board-core.js   state, drawing (SVG), geometry, applying changes, history (undo/redo). Item = {id,k,x,y,w,h,r,z,d}; op = add | upd | del; null in d removes a key
  wwwroot/js/board-net.js    snapshot load (+ copy in Cache Storage "mb-boards"), WebSocket, queue of unconfirmed ops (localStorage mb.q.<board>, replayed after reconnect), presence, cursors
  wwwroot/js/board-ui.js     tools, pointer gestures (mouse/pen/touch, pinch), selection + handles, alignment guides, quick connect, lock, text editing overlay, bar over the selection, clipboard, images, export, keys; exposes MB.ui
  wwwroot/js/board-extras.js the side panel (templates, comment threads, frames, search), presenting frames, minimap, following a person, summon, the tooltips of the board (one floating .mb-tip kept inside the window; the toolkit's ::after tips are off on the board)
  wwwroot/css/app.css        accent + few app styles (prefix mb-);  board.css = the board page
  wwwroot/sw.js              service worker: static cache, last board pages offline, offline.html; clears on sign-out (pwa.js)
tests/MatBoard.Tests         unit + database tests (PlatformTests: the definition against the MatUi sprite, consumes, contributions; PlatformAppTests: the app in
                             memory on a test database: /api, /api/connections, the Connections page for administrators only, MAT_PUBLIC_URL)
```

## Conventions

**Database (PostgreSQL)**: tables PascalCase and singular, key always `Id` BIGINT, every record has `CreateDate/CreateUserId/UpdateDate/UpdateUserId` (filled by `AppDbContext.SaveChanges`),
`UpdateState` (0 deleted, 1 created, 2 updated) for soft delete (`Board`, `User`), a `Token` (uuid) for a security key (`UserSession.Token`, `Board.ShareToken`). `BoardItem.Uid` is the id a browser makes up
for an item (so others can refer to it, e.g. the ends of a connector); the content of an item is a `jsonb` column `Data`.

**Security**: every board query goes through `BoardAccess`; a board you may not see answers 404. Every WebSocket batch re-checks the right (`BoardItems.ApplyAsync`); `BoardRooms.Revalidate`
runs after members/link change. Pictures are bitmap data addresses only. The CSP forbids inline script and style (scripts set styles through the CSSOM). Text is always put into the page with
`textContent`, never as HTML. Mail addresses are never logged in full. The Connections area and its form (`/api/connections/form`) are for administrators only
(`MatPlatformOptions.ConnectionsAccess` = the role Admin). `MAT_FRAME_ANCESTORS` (MatPlatform) replaces `frame-ancestors 'none'` / `X-Frame-Options` of `SecurityHeaders` when set.

**UI (MatDesign rules)**: CRUD = list page (toolbar above, table, pager under it, actions left below) + separate edit page (Save, Back, space, Delete); a board has three **tabs** (General, People, Link) that
are pages of their own. Icons via `Ui.Icon` (toolkit sprite + `wwwroot/img/app-icons.svg`; a missing name is a bug). Every `td` has `data-label`. The version at the foot of the menu links to `/About`.

**Code**: Microsoft C# guidelines, file-scoped namespaces, `.editorconfig`. The business layer is static classes taking the `AppDbContext` and the actor. No database queries in page models or views
beyond calling the business layer. English identifiers and comments, UI texts only in the catalog.

**Compose files**: no environment variables to set, no placeholders; a stack (`name:`) per file; `docker-compose.yml` (release), `.dev.yml` (nightly + pgAdmin), `.local.yml` (build + pgAdmin).

**Git**: commit under the user's name; never add a Claude/Anthropic co-author trailer or a "generated with" line (global rule of the user; it overrides any default). Branches: `main` = release, `dev` =
development. Versions: release `<major>.<minor>.<build>-<date>`, development `nightly-<build>-<date>`, local `local-<date>` (`Directory.Build.props`; `.github/workflows/build.yml` builds, tests and pushes the image).
