using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MatBoard.Data;
using MatBoard.Platform;
using MatBoard.Services;
using MatPlatform;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;

namespace MatBoard.Tests;

/// <summary>
/// The description of MatBoard for the platform (contract 2): valid against the MatUi sprite, what it consumes, its launcher, quick actions and widgets, the public
/// address fixed by MAT_PUBLIC_URL.
/// </summary>
public sealed partial class PlatformTests
{
    private static readonly string Web = Path.Combine(Root(), "src", "MatBoard");

    [Theory]
    [InlineData("de")]
    [InlineData("en")]
    public void The_definition_is_valid_with_the_icons_of_the_MatUi_sprite(string language)
    {
        var sprite = MatPlatformValidator.ReadSprite(Path.Combine(Web, "wwwroot", "matui", "matui-icons.svg"));
        Assert.Empty(MatPlatformValidator.Validate(MatPlatformBuilder.Build(MatBoardPlatform.Describe, language), sprite));
        Assert.Empty(MatPlatformValidator.Validate(MatPlatformBuilder.Build(o => MatBoardPlatform.Describe(o, "https://board.example.com"), language), sprite));
    }

    [Fact]
    public void MatBoard_consumes_the_sign_in_and_the_mail_and_contributes_a_launcher_and_widgets_for_administrators()
    {
        var definition = MatPlatformBuilder.Build(MatBoardPlatform.Describe, "en");
        Assert.Equal(2, MatApiDefinition.ContractVersion);
        Assert.Equal(MatApiDefinition.ContractVersion, definition.Contract);
        Assert.Empty(definition.Provides);
        Assert.Equal([MatCapabilities.IdentityOidc, MatCapabilities.MailSmtp], definition.Consumes.Select(c => c.Capability));
        Assert.All(definition.Consumes, c => Assert.True(c.Optional));

        var contributes = definition.Contributes!;
        var launcher = Assert.Single(contributes.Launchers);
        Assert.Equal(("boards", "MatBoard", "/Boards"), (launcher.Id, launcher.Label, launcher.Url));
        Assert.True(File.Exists(Path.Combine(Web, "wwwroot", launcher.Icon.TrimStart('/'))), launcher.Icon);

        // the quick actions are the main views of the menu: a new board, my boards, shared with me (Pages/Boards: /Boards/Edit, /Boards?scope=)
        Assert.Equal(["/Boards/Edit", "/Boards?scope=mine", "/Boards?scope=shared"], contributes.QuickActions.Select(q => q.Url));
        Assert.All(contributes.QuickActions, q => Assert.Equal("boards", q.Launcher));

        // every address leads to a real page of the app
        var routes = Routes();
        var addresses = contributes.QuickActions.Select(q => q.Url!).Append(launcher.Url).Concat(contributes.Widgets.Select(w => w.Url!));
        Assert.All(addresses, url => Assert.Contains(url.Split('?')[0], routes));

        // widgets only from the tiles that exist, only for administrators (the numbers of the whole installation)
        Assert.Equal(["boards", "users"], contributes.Widgets.Select(w => w.Id));
        Assert.All(contributes.Widgets, w => Assert.Equal(MatAudience.Admin, w.Audience));
        Assert.Equal(["boards", "sharedBoards", "linkedBoards", "changedLast7Days"], contributes.Widgets[0].Items);
        var tiles = definition.Pages.Single(p => p.Id == "overview").Sections.Where(s => s.Kind == "tiles").SelectMany(s => s.Items).ToHashSet();
        Assert.All(contributes.Widgets.SelectMany(w => w.Items), key => Assert.Contains(key, tiles));

        Assert.Contains(definition.Actions, a => a.Id == "openConnections" && a.Url == "/Admin/Connections");
        Assert.Contains("openConnections", definition.Pages.Single(p => p.Id == "overview").Sections.Single(s => s.Kind == "actions").Items);
    }

    [Fact]
    public void MAT_PUBLIC_URL_fixes_the_public_address()
    {
        Assert.Null(MatPlatformBuilder.Build(MatBoardPlatform.Describe, "en").Configure.Single(f => f.Key == "publicUrl").Fixed);
        var field = MatPlatformBuilder.Build(o => MatBoardPlatform.Describe(o, "https://board.example.com"), "en").Configure.Single(f => f.Key == "publicUrl");
        Assert.True(field.Fixed);
        Assert.Contains("MAT_PUBLIC_URL", field.Hint, StringComparison.Ordinal);
    }

    /// <summary>The addresses of the pages (<c>@page "/Boards"</c>), without the parameters of a route.</summary>
    private static HashSet<string> Routes()
        => Directory.EnumerateFiles(Path.Combine(Web, "Pages"), "*.cshtml", SearchOption.AllDirectories)
            .Select(f => PageRegex().Match(File.ReadAllText(f)))
            .Where(m => m.Success)
            .Select(m => m.Groups["route"].Value)
            .ToHashSet(StringComparer.Ordinal);

    [GeneratedRegex("""^@page "(?<route>/[^"{]*?)/?"\s*$""", RegexOptions.Multiline)]
    private static partial Regex PageRegex();

    internal static string Root()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "MatBoard.slnx")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new InvalidOperationException("MatBoard.slnx not found.");
    }
}

/// <summary>
/// MatBoard in memory (a database of its own per test): the platform endpoints of contract 2, the Connections page for administrators only, the public address
/// fixed by MAT_PUBLIC_URL and editable without it.
/// </summary>
public sealed partial class PlatformAppTests
{
    private const string ApiKey = "test-api-key-0123456789";
    private const string Password = "Start12345";

    [DbFact]
    public async Task The_api_says_contract_2_and_what_MatBoard_contributes()
    {
        await using var app = await TestApp.StartAsync();
        using var api = app.Api();
        var definition = await api.GetFromJsonAsync<JsonElement>("/api");
        Assert.Equal(2, definition.GetProperty("contract").GetInt32());
        Assert.Equal(["identity.oidc", "mail.smtp"], definition.GetProperty("consumes").EnumerateArray().Select(c => c.GetProperty("capability").GetString()));
        var contributes = definition.GetProperty("contributes");
        Assert.Equal("boards", contributes.GetProperty("launchers")[0].GetProperty("id").GetString());
        Assert.Equal(3, contributes.GetProperty("quickActions").GetArrayLength());
        Assert.Equal(2, contributes.GetProperty("widgets").GetArrayLength());

        // the widgets show values that /api/state answers
        var state = (await api.GetFromJsonAsync<JsonElement>("/api/state")).GetProperty("values");
        foreach (var widget in contributes.GetProperty("widgets").EnumerateArray())
        {
            Assert.All(widget.GetProperty("items").EnumerateArray(), key => Assert.True(state.TryGetProperty(key.GetString()!, out _), key.GetString()));
        }
    }

    [DbFact]
    public async Task The_connections_answer_only_to_the_key()
    {
        await using var app = await TestApp.StartAsync();
        using var anonymous = app.Client();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/connections")).StatusCode);

        using var api = app.Api();
        var answer = await api.GetAsync("/api/connections");
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        var connections = await answer.Content.ReadFromJsonAsync<JsonElement>();
        var uses = connections.GetProperty("uses").EnumerateArray().ToList();
        Assert.Equal(["identity.oidc", "mail.smtp"], uses.Select(u => u.GetProperty("capability").GetString()));
        Assert.All(uses, u => Assert.Equal("none", u.GetProperty("source").GetString()));
        Assert.Empty(connections.GetProperty("offers").EnumerateArray());
        Assert.Equal("boards", connections.GetProperty("contributes").GetProperty("launchers")[0].GetProperty("id").GetString());
    }

    [DbFact]
    public async Task The_Connections_page_opens_for_an_administrator_and_not_for_a_user()
    {
        await using var app = await TestApp.StartAsync();
        await app.AddUserAsync("admin@example.com", UserRole.Admin);
        await app.AddUserAsync("user@example.com", UserRole.User);

        using var admin = await app.SignInAsync("admin@example.com");
        var page = await admin.GetAsync("/Admin/Connections");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        var html = await page.Content.ReadAsStringAsync();
        Assert.Contains("data-connections", html, StringComparison.Ordinal);
        Assert.Contains("New board", html, StringComparison.Ordinal);
        Assert.Contains("href=\"/Admin/Connections\"", html, StringComparison.Ordinal);

        using var user = await app.SignInAsync("user@example.com");
        var denied = await user.GetAsync("/Admin/Connections");
        Assert.Equal(HttpStatusCode.Redirect, denied.StatusCode);
        Assert.Equal("/Account/Login", new Uri(new Uri("http://localhost"), denied.Headers.Location!).AbsolutePath);
        Assert.DoesNotContain("href=\"/Admin/Connections\"", await user.GetStringAsync("/Boards"), StringComparison.Ordinal);
    }

    [DbFact]
    public async Task MAT_PUBLIC_URL_fixes_the_public_address_and_leaves_the_stored_one_alone()
    {
        await using var app = await TestApp.StartAsync(("MAT_PUBLIC_URL", "https://board.example.com/"));
        app.Database.Db.SystemSettings.Add(new SystemSetting { Id = 1, PublicUrl = "https://stored.example.com" });
        await app.Database.Db.SaveChangesAsync();

        using var api = app.Api();
        var definition = await api.GetFromJsonAsync<JsonElement>("/api");
        var field = definition.GetProperty("configure").EnumerateArray().Single(f => f.GetProperty("key").GetString() == "publicUrl");
        Assert.True(field.GetProperty("fixed").GetBoolean());

        var values = (await api.GetFromJsonAsync<JsonElement>("/api/configure")).GetProperty("values");
        Assert.Equal("https://board.example.com", values.GetProperty("publicUrl").GetString());
        var refused = await api.PutAsync("/api/configure", Json("""{"values":{"publicUrl":"https://other.example.com"}}"""));
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);

        // the admin page shows it read-only; saving the page keeps the stored address
        await app.AddUserAsync("admin@example.com", UserRole.Admin);
        using var admin = await app.SignInAsync("admin@example.com");
        var html = await admin.GetStringAsync("/Admin/System");
        Assert.Contains("Set by the variable MAT_PUBLIC_URL", html, StringComparison.Ordinal);
        Assert.Contains("value=\"https://board.example.com\"", html, StringComparison.Ordinal);
        var saved = await admin.PostAsync("/Admin/System", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["RegistrationOpen"] = "false",
            ["PublicUrl"] = "https://posted.example.com",
            ["__RequestVerificationToken"] = TestApp.TokenOf(html),
        }));
        Assert.Equal(HttpStatusCode.Redirect, saved.StatusCode);

        app.Database.Db.ChangeTracker.Clear();
        Assert.Equal("https://stored.example.com", (await app.Database.Db.SystemSettings.SingleAsync()).PublicUrl);
    }

    [DbFact]
    public async Task Without_MAT_PUBLIC_URL_the_public_address_is_editable()
    {
        await using var app = await TestApp.StartAsync();
        using var api = app.Api();
        var definition = await api.GetFromJsonAsync<JsonElement>("/api");
        var field = definition.GetProperty("configure").EnumerateArray().Single(f => f.GetProperty("key").GetString() == "publicUrl");
        Assert.False(field.TryGetProperty("fixed", out _));

        var saved = await api.PutAsync("/api/configure", Json("""{"values":{"publicUrl":"https://board.example.com/"}}"""));
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var values = (await api.GetFromJsonAsync<JsonElement>("/api/configure")).GetProperty("values");
        Assert.Equal("https://board.example.com", values.GetProperty("publicUrl").GetString());
    }

    private static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");

    /// <summary>MatBoard in memory on a database and a data folder of its own, with <c>MAT_API_KEY</c> and the variables a test names.</summary>
    private sealed partial class TestApp : IAsyncDisposable
    {
        private readonly string _data = Path.Combine(Path.GetTempPath(), "matboard-tests", Guid.NewGuid().ToString("N")[..12]);
        private WebApplicationFactory<Program> _factory = null!;

        public TestDatabase Database { get; private set; } = null!;

        public static async Task<TestApp> StartAsync(params (string Key, string Value)[] settings)
        {
            var app = new TestApp { Database = await TestDatabase.CreateAsync() };
            Directory.CreateDirectory(app._data);
            app._factory = new WebApplicationFactory<Program>().WithWebHostBuilder(web =>
            {
                web.UseEnvironment("Testing");
                web.UseSetting("ConnectionStrings:Default", app.Database.Db.Database.GetConnectionString());
                web.UseSetting("DataDirectory", app._data);
                web.UseSetting("Logging:LogLevel:Default", "Warning");
                web.UseSetting("MAT_API_KEY", ApiKey);
                foreach (var (key, value) in settings)
                {
                    web.UseSetting(key, value);
                }
            });
            return app;
        }

        /// <summary>A browser without a sign-in (cookies kept, no redirects followed), in English.</summary>
        public HttpClient Client()
        {
            var client = _factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
            client.DefaultRequestHeaders.AcceptLanguage.ParseAdd("en");
            return client;
        }

        /// <summary>A caller of the platform API with the key.</summary>
        public HttpClient Api()
        {
            var client = Client();
            client.DefaultRequestHeaders.Add("X-Api-Key", ApiKey);
            return client;
        }

        /// <summary>An account with the test password.</summary>
        public async Task AddUserAsync(string email, UserRole role)
        {
            Database.Db.Users.Add(new User { Email = email, DisplayName = email.Split('@')[0], PasswordHash = new PasswordService().Hash(Password), Role = role });
            await Database.Db.SaveChangesAsync();
        }

        /// <summary>A browser signed in through the local sign-in form.</summary>
        public async Task<HttpClient> SignInAsync(string email)
        {
            var client = Client();
            var form = await client.GetStringAsync("/Account/Login?local=1");
            var answer = await client.PostAsync("/Account/Login?local=1", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["Email"] = email,
                ["Password"] = Password,
                ["__RequestVerificationToken"] = TokenOf(form),
            }));
            Assert.Equal(HttpStatusCode.Redirect, answer.StatusCode);
            return client;
        }

        public static string TokenOf(string html)
        {
            var match = TokenRegex().Match(html);
            Assert.True(match.Success, "no anti-forgery token on the page");
            return WebUtility.HtmlDecode(match.Groups["token"].Value);
        }

        public async ValueTask DisposeAsync()
        {
            await _factory.DisposeAsync();
            await Database.DisposeAsync();
            if (Directory.Exists(_data))
            {
                Directory.Delete(_data, recursive: true);
            }
        }

        [GeneratedRegex("""name="__RequestVerificationToken" type="hidden" value="(?<token>[^"]+)""")]
        private static partial Regex TokenRegex();
    }
}
