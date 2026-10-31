using MatBoard.Data;
using MatBoard.Services.Boards;
using Microsoft.EntityFrameworkCore;

namespace MatBoard.Services;

/// <summary>What the menu shows: the boards the person worked on last.</summary>
public sealed class MenuModel
{
    public IReadOnlyList<(long Id, string Name, string Color)> Recent { get; init; } = [];

    public int Mine { get; init; }

    public int Shared { get; init; }
}

/// <summary>One menu of the switcher at the foot of the menu.</summary>
public sealed record MenuArea(string Id, string Title, string Icon);

public sealed class MenuService(AppDbContext db, CurrentUser me)
{
    private MenuModel? _model;

    /// <summary>The menus of the switcher: the boards, the settings of the person and, for an administrator, the administration.</summary>
    public static IReadOnlyList<MenuArea> Areas(bool admin)
    {
        var list = new List<MenuArea>
        {
            new("boards", Localization.Text.T("Shell.Area.Boards"), "layout"),
            new("settings", Localization.Text.T("Settings.Title"), "settings"),
        };
        if (admin)
        {
            list.Add(new MenuArea("admin", Localization.Text.T("Admin.Title"), "shield"));
        }

        return list;
    }

    /// <summary>The menu a page belongs to, by its address.</summary>
    public static string AreaOf(string? path)
    {
        path ??= "/";
        bool Under(string prefix) => path.Equals(prefix, StringComparison.OrdinalIgnoreCase) || path.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase);
        if (Under("/Admin"))
        {
            return "admin";
        }

        return Under("/Account") ? "settings" : "boards";
    }

    public async Task<MenuModel> GetAsync()
    {
        if (_model is not null)
        {
            return _model;
        }

        var userId = me.RequiredId;
        var visible = BoardAccess.Visible(db, userId);
        _model = new MenuModel
        {
            Recent = await BoardService.RecentAsync(db, userId, 6),
            Mine = await visible.CountAsync(b => b.OwnerId == userId),
            Shared = await visible.CountAsync(b => b.OwnerId != userId),
        };
        return _model;
    }
}
