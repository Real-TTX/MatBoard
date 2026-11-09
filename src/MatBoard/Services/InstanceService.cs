using MatBoard.Data;
using MatBoard.Localization;
using MatPlatform;
using Microsoft.EntityFrameworkCore;

namespace MatBoard.Services;

/// <summary>The numbers of the installation (the platform tiles, the admin page System). Nothing here says what is on a board: only how many.</summary>
public sealed record InstanceSnapshot(
    int Users,
    int Admins,
    int Boards,
    int SharedBoards,
    int LinkedBoards,
    int Items,
    int ChangedLast7Days,
    DateTime? LastActivityUtc);

/// <summary>What the housekeeping removed.</summary>
public sealed record CleanUpResult(int Sessions, int Boards);

/// <summary>
/// The installation as a whole: its numbers, the few settings of the system (registration, public address), the state of the database and the housekeeping.
/// The admin page System, the platform contract (<c>Platform/MatBoardPlatform</c>) and the background housekeeping go through it, so none of them needs the database itself.
/// A broker such as Mattiverse may set the public address (<c>MAT_PUBLIC_URL</c>): then it wins and the stored value stays as it is (it comes back when the variable goes).
/// </summary>
public sealed class InstanceService(AppDbContext db, AccountService accounts, MatPlatformSettings platform)
{
    /// <summary>Does <c>MAT_PUBLIC_URL</c> set the public address (then it cannot be changed on the admin page or through the platform API)?</summary>
    public bool PublicUrlFixed => platform.AppPublicUrl is not null;

    /// <summary>Can the database be reached (the health check)?</summary>
    public async Task<bool> CanConnectAsync(CancellationToken ct = default)
    {
        try
        {
            return await db.Database.CanConnectAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return false;
        }
    }

    /// <summary>The numbers of the installation.</summary>
    public async Task<InstanceSnapshot> SnapshotAsync(CancellationToken ct = default)
    {
        var weekAgo = DateTime.UtcNow.AddDays(-7);
        return new InstanceSnapshot(
            Users: await db.Users.CountAsync(u => u.IsActive, ct),
            Admins: await db.Users.CountAsync(u => u.IsActive && u.Role == UserRole.Admin, ct),
            Boards: await db.Boards.CountAsync(ct),
            SharedBoards: await db.Boards.CountAsync(b => b.Members.Any(), ct),
            LinkedBoards: await db.Boards.CountAsync(b => b.LinkMode != LinkMode.Off, ct),
            Items: await db.BoardItems.CountAsync(ct),
            ChangedLast7Days: await db.Boards.CountAsync(b => b.UpdateDate >= weekAgo && b.Revision > 0, ct),
            LastActivityUtc: await db.Boards.MaxAsync(b => (DateTime?)b.UpdateDate, ct));
    }

    /// <summary>Has anybody registered yet?</summary>
    public Task<bool> AnyUserAsync() => accounts.AnyUserAsync();

    /// <summary>Where the data is: <c>PostgreSQL host:port/database</c> (for the admin page; never in the platform API).</summary>
    public string DatabaseName()
    {
        var cs = new Npgsql.NpgsqlConnectionStringBuilder(db.Database.GetConnectionString());
        return $"PostgreSQL {cs.Host}:{cs.Port}/{cs.Database}";
    }

    /// <summary>Whether sign-up is open and the public address in force: <c>MAT_PUBLIC_URL</c>, else the stored one; null = the address of the request.</summary>
    public async Task<(bool RegistrationOpen, string? PublicUrl)> SettingsAsync()
    {
        var s = await accounts.SettingsAsync();
        return (s.RegistrationOpen, platform.AppPublicUrl ?? NormalizePublicUrl(s.PublicUrl));
    }

    /// <summary>
    /// Saves the settings of the system; a <c>null</c> leaves a value as it is, an empty address clears it. A public address that <c>MAT_PUBLIC_URL</c> sets is left
    /// as it is. Answers the message for a public address that is not an absolute http(s) address (nothing is saved then), else <c>null</c>.
    /// </summary>
    public async Task<string?> SaveSettingsAsync(bool? registrationOpen, string? publicUrl)
    {
        publicUrl = PublicUrlFixed ? null : publicUrl;
        string? url = null;
        if (publicUrl is not null)
        {
            url = NormalizePublicUrl(publicUrl);
            if (url is not null && !IsPublicUrl(url))
            {
                return Text.T("System.PublicUrl.Invalid");
            }
        }

        var s = await accounts.SettingsAsync();
        if (registrationOpen is { } open)
        {
            s.RegistrationOpen = open;
        }

        if (publicUrl is not null)
        {
            s.PublicUrl = url;
        }

        await db.SaveChangesAsync();
        return null;
    }

    /// <summary>The address without spaces and the last slash; <c>null</c> when empty.</summary>
    public static string? NormalizePublicUrl(string? url)
    {
        var trimmed = (url ?? string.Empty).Trim().TrimEnd('/');
        return trimmed.Length == 0 ? null : trimmed;
    }

    public static bool IsPublicUrl(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https";

    /// <summary>The housekeeping: ended and old sessions go, and a board that was deleted more than 30 days ago is removed for good (with everything on it).</summary>
    public async Task<CleanUpResult> CleanUpAsync(CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var limit = now.AddDays(-30);
        var sessions = await db.Sessions.Where(s => s.IsRevoked || s.ExpiresDate < now.AddDays(-1)).ExecuteDeleteAsync(ct);
        var boards = await db.Boards.IgnoreQueryFilters().Where(b => b.UpdateState == SoftEntity.Deleted && b.UpdateDate < limit).ExecuteDeleteAsync(ct);
        return new CleanUpResult(sessions, boards);
    }
}
