using System.Text.Json;
using MatBoard.Services;
using MatPlatform;

namespace MatBoard.Platform;

/// <summary>
/// MatBoard as an app of the platform contract (MatDesign docs/PLATFORM.md) on the shared package MatPlatform (the folder <c>MatPlatform/</c>, a copy):
/// how a consumer such as Mattiverse shows MatBoard (<see cref="Describe"/>: tiles, the few settings, buttons), its values and what its buttons do.
/// The settings are the two of the admin page System (registration, public address), kept in the same place (<see cref="InstanceService"/>).
/// The values come from the services (no DbContext here: this is the web layer).
/// </summary>
public sealed class MatBoardPlatform(InstanceService instance, ILogger<MatBoardPlatform> log)
    : IMatPlatformState, IMatPlatformConfiguration, IMatPlatformActions, IMatPlatformHealth
{
    /// <summary>The id of MatBoard in the platform (and the default client id at MatIdentity), as in MatDesign <c>AppRegistry.cs</c>.</summary>
    public const string AppId = "matboard";

    /// <summary>The accent of MatBoard (a warm yellow, close to but not the same as the yellow of Miro, see <c>wwwroot/css/app.css</c>).</summary>
    public const string Accent = "#ffc21f";

    /// <summary>The MatApiDefinition of MatBoard (<c>GET /api</c>); <c>auth</c> and <c>endpoints</c> are set by MatPlatform.</summary>
    public static void Describe(MatPlatformBuilder o)
    {
        var T = o.T;

        o.App(AppId, "MatBoard", T("Digitales Whiteboard für die Zusammenarbeit im Team", "A digital whiteboard for working together"), AppInfo.Version, "/img/logo/matboard-mark.svg", Accent, "/Boards");

        o.Page("overview", T("Übersicht", "Overview"), "dashboard",
            MatSection.Tiles("users", "boards", "sharedBoards", "linkedBoards", "items", "changedLast7Days", "registration", "lastActivity"),
            MatSection.Actions("openApp", "openUsers", "openSystem", "cleanUp"));
        o.Page("settings", T("Einstellungen", "Settings"), "settings",
            MatSection.Form(T("Allgemein", "General"), "registrationOpen", "publicUrl"));

        o.Tile("users", T("Aktive Benutzer", "Active users"), icon: "users");
        o.Tile("boards", T("Boards", "Boards"), icon: "layout");
        o.Tile("sharedBoards", T("Geteilte Boards", "Shared boards"), icon: "users");
        o.Tile("linkedBoards", T("Boards mit Link", "Boards with a link"), icon: "link");
        o.Tile("items", T("Objekte auf Boards", "Objects on boards"), icon: "layers");
        o.Tile("changedLast7Days", T("Geändert in 7 Tagen", "Changed in 7 days"), icon: "activity");
        o.Tile("registration", T("Registrierung", "Sign-up"), "status", icon: "user");
        o.Tile("lastActivity", T("Letzte Änderung an einem Board", "Last change to a board"), "time", icon: "activity");

        o.Field(new MatField("registrationOpen", T("Registrierung offen", "Open sign-up"), "bool")
        {
            Hint = T("Aus: nur Administratoren legen Konten an.", "Off: only administrators create accounts."),
        });
        o.Field(new MatField("publicUrl", T("Öffentliche Adresse", "Public address"), "url")
        {
            Max = 300,
            Placeholder = "https://board.example.com",
            Hint = T("Für die Adressen in E-Mails; leer: die Adresse des Aufrufs.", "For the addresses in mails; empty: the address of the request."),
        });

        o.LinkAction("openApp", T("Öffnen", "Open"), "external", "/Boards");
        o.LinkAction("openUsers", T("Benutzer", "Users"), "users", "/Admin/Users");
        o.LinkAction("openSystem", T("System", "System"), "settings", "/Admin/System");
        o.PostAction(
            "cleanUp",
            T("Aufräumen", "Clean up"),
            "broom",
            T("Beendete Sitzungen und vor mehr als 30 Tagen gelöschte Boards jetzt endgültig entfernen?",
              "Remove ended sessions and the boards deleted more than 30 days ago for good now?"));

        o.Role("admin", T("Administrator", "Administrator"));
        o.Role("user", T("Benutzer", "User"));
    }

    public async Task<IReadOnlyList<MatHealthCheck>> CheckHealthAsync(MatPlatformCall call, CancellationToken ct)
    {
        if (!await instance.CanConnectAsync(ct))
        {
            return [new MatHealthCheck("database", "down", call.T("Die Datenbank ist nicht erreichbar.", "The database cannot be reached."))];
        }

        var checks = new List<MatHealthCheck> { new("database", "ok") };
        if (await instance.AnyUserAsync() && (await instance.SnapshotAsync(ct)).Admins == 0)
        {
            checks.Add(new MatHealthCheck("administrators", "degraded", call.T("Kein aktiver Administrator.", "No active administrator.")));
        }

        return checks;
    }

    public async Task<IReadOnlyDictionary<string, MatStateValue>> GetStateAsync(MatPlatformCall call, CancellationToken ct)
    {
        var s = await instance.SnapshotAsync(ct);
        var (open, _) = await instance.SettingsAsync();
        return new Dictionary<string, MatStateValue>
        {
            ["users"] = new(s.Users),
            ["boards"] = new(s.Boards),
            ["sharedBoards"] = new(s.SharedBoards),
            ["linkedBoards"] = new(s.LinkedBoards),
            ["items"] = new(s.Items),
            ["changedLast7Days"] = new(s.ChangedLast7Days),
            ["registration"] = open
                ? new MatStateValue("info", Text: call.T("Offen", "Open"))
                : new MatStateValue("ok", Text: call.T("Geschlossen", "Closed")),
            ["lastActivity"] = new(s.LastActivityUtc is { } last ? new DateTimeOffset(DateTime.SpecifyKind(last, DateTimeKind.Utc)) : null),
        };
    }

    public async Task<IReadOnlyDictionary<string, object?>> GetConfigurationAsync(MatPlatformCall call, CancellationToken ct)
    {
        var (open, url) = await instance.SettingsAsync();
        return new Dictionary<string, object?>
        {
            ["registrationOpen"] = open,
            ["publicUrl"] = url ?? string.Empty,
        };
    }

    /// <summary>The values are checked against the definition already (MatPlatform, <c>CheckValues</c>); the address is checked once more like on the admin page.</summary>
    public async Task<IReadOnlyDictionary<string, string>> ConfigureAsync(IReadOnlyDictionary<string, JsonElement> values, MatPlatformCall call, CancellationToken ct)
    {
        var errors = new Dictionary<string, string>();
        bool? open = null;
        string? url = null;
        foreach (var (key, value) in values)
        {
            switch (key)
            {
                case "registrationOpen" when value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                    open = value.GetBoolean();
                    break;
                case "publicUrl" when value.ValueKind is JsonValueKind.String:
                    url = value.GetString()!;
                    break;
                case "publicUrl" when value.ValueKind is JsonValueKind.Null:
                    url = string.Empty;
                    break;
                default:
                    errors[key] = call.T("Dieser Wert passt nicht.", "This value does not fit.");
                    break;
            }
        }

        if (url is not null && InstanceService.NormalizePublicUrl(url) is { } normalized && !InstanceService.IsPublicUrl(normalized))
        {
            errors["publicUrl"] = call.T("Eine vollständige Adresse mit http:// oder https://.", "A complete address with http:// or https://.");
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        await instance.SaveSettingsAsync(open, url);

        // MatBoard has no activity log of its own: the change (the keys, no values) goes to the log of the app.
        log.LogInformation("Settings changed through the platform API by {Caller}: {Keys}", call.Caller, string.Join(", ", values.Keys));
        return errors;
    }

    public async Task<MatActionResult?> RunActionAsync(string id, MatPlatformCall call, CancellationToken ct)
    {
        if (id != "cleanUp")
        {
            return null;
        }

        var result = await instance.CleanUpAsync(ct);
        log.LogInformation("Clean-up through the platform API by {Caller}: {Sessions} sessions, {Boards} boards", call.Caller, result.Sessions, result.Boards);
        return new MatActionResult(true, call.T(
            $"Aufgeräumt: {result.Sessions} Sitzungen, {result.Boards} Boards.",
            $"Cleaned up: {result.Sessions} sessions, {result.Boards} boards."));
    }
}
