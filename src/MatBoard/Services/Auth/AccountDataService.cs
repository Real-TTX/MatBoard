using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using MatBoard.Data;
using Microsoft.EntityFrameworkCore;

namespace MatBoard.Services.Auth;

/// <summary>
/// The data of a person under the GDPR: the export of everything that is about them (Art. 15 and 20, a JSON file), and the erasure of the account (Art. 17).
/// <para>
/// The export holds the account and its settings, the boards the person owns with everything on them (every item, with the people the board is shared with), the boards
/// shared with them (name and role) and the sessions (and whether the account is linked with a person of MatIdentity). No secret: no password hash, no token of a session or
/// of a link, no ID token.
/// </para>
/// <para>
/// The erasure deletes for good (the account is not just hidden): the boards the person owns with everything on them, their memberships and sessions. What they put on a
/// board of somebody else stays there, without their name (the audit columns are cleared).
/// </para>
/// </summary>
public sealed class AccountDataService(AppDbContext db)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>The export as JSON (UTF-8).</summary>
    public async Task<byte[]> ExportAsync(long userId, CancellationToken ct = default)
    {
        var user = await db.Users.AsNoTracking().FirstAsync(u => u.Id == userId, ct);
        var boards = await db.Boards.IgnoreQueryFilters().AsNoTracking().Where(b => b.OwnerId == userId).OrderBy(b => b.Id).ToListAsync(ct);
        var boardIds = boards.Select(b => b.Id).ToList();
        var items = await db.BoardItems.AsNoTracking().Where(i => boardIds.Contains(i.BoardId)).OrderBy(i => i.Z).ThenBy(i => i.Id).ToListAsync(ct);
        var members = await db.BoardMembers.AsNoTracking().Where(m => boardIds.Contains(m.BoardId)).Select(m => new { m.BoardId, m.User!.DisplayName, m.Role }).ToListAsync(ct);
        var shared = await db.BoardMembers.AsNoTracking().Where(m => m.UserId == userId).Select(m => new { m.Board!.Name, m.Role, m.CreateDate }).ToListAsync(ct);

        var export = new
        {
            Format = "MatBoard export 1",
            ExportedAt = DateTime.UtcNow,
            Account = new
            {
                user.Email,
                user.DisplayName,
                user.Role,
                user.TimeZone,
                user.Language,
                user.Theme,
                user.Scheme,
                user.CursorColor,
                user.MailOnShare,
                user.CreateDate,
                user.LastLoginDate,
                LinkedWithMatIdentity = user.ExternalSubject != null,
            },
            Boards = boards.Select(b => new
            {
                b.Id,
                b.Name,
                b.Description,
                b.Color,
                b.Background,
                b.LinkMode,
                b.CreateDate,
                b.UpdateDate,
                Deleted = b.UpdateState == SoftEntity.Deleted ? true : (bool?)null,
                Members = members.Where(m => m.BoardId == b.Id).Select(m => new { Name = m.DisplayName, m.Role }).ToList(),
                Items = items.Where(i => i.BoardId == b.Id).Select(i => new
                {
                    Id = i.Uid,
                    i.Kind,
                    i.X,
                    i.Y,
                    Width = i.Width,
                    Height = i.Height,
                    i.Rotation,
                    i.Z,
                    Data = JsonNode.Parse(i.Data),
                }).ToList(),
            }).ToList(),
            SharedWithYou = shared.Select(s => new { s.Name, s.Role, Since = s.CreateDate }).ToList(),
            Sessions = await db.Sessions.AsNoTracking().Where(s => s.UserId == userId)
                .Select(s => new { s.CreateDate, s.LastSeenDate, s.ExpiresDate, s.IsRevoked, s.UserAgent, s.IpAddress }).ToListAsync(ct),
        };

        return JsonSerializer.SerializeToUtf8Bytes(export, Json);
    }

    /// <summary>Erases the account for good (see the class). The caller checks the password and that it is not the last administrator.</summary>
    public async Task EraseAsync(long userId, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // what the person put on other people's boards stays, without their name
        await db.BoardItems.Where(i => i.CreateUserId == userId).ExecuteUpdateAsync(s => s.SetProperty(i => i.CreateUserId, (long?)null), ct);
        await db.BoardItems.Where(i => i.UpdateUserId == userId).ExecuteUpdateAsync(s => s.SetProperty(i => i.UpdateUserId, (long?)null), ct);

        // the account: the database deletes its sessions, its boards (with their items and members) and its memberships with it
        await db.Users.IgnoreQueryFilters().Where(u => u.Id == userId).ExecuteDeleteAsync(ct);
        await tx.CommitAsync(ct);
    }

    /// <summary>Is the person the last active administrator (who must not go, or nobody can run the installation)?</summary>
    public async Task<bool> IsLastAdminAsync(long userId)
        => await db.Users.AnyAsync(u => u.Id == userId && u.Role == UserRole.Admin && u.IsActive)
           && !await db.Users.AnyAsync(u => u.Id != userId && u.Role == UserRole.Admin && u.IsActive);
}
