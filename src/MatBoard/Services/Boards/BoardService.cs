using MatBoard.Data;
using MatBoard.Localization;
using Microsoft.EntityFrameworkCore;

namespace MatBoard.Services.Boards;

/// <summary>One row of the list of boards.</summary>
public sealed record BoardRow(long Id, string Name, string? Description, string Color, string OwnerName, BoardRole Role, int Members, DateTime UpdateDate, DateTime CreateDate)
{
    public bool Mine => Role == BoardRole.Owner;
}

/// <summary>What the list of boards is asked for: <c>Scope</c> is <c>all</c>, <c>mine</c> or <c>shared</c>; <c>Sort</c> is <c>name</c>, <c>changed</c> or <c>created</c>.</summary>
public sealed record BoardQuery(string? Search, string? Scope, string Sort, bool Descending);

public sealed record BoardPage(IReadOnlyList<BoardRow> Rows, int Total, int Matching);

/// <summary>A person a board is shared with, as the owner sees them.</summary>
public sealed record MemberRow(long UserId, string Name, string Email, BoardRole Role);

/// <summary>The answer of a change: what came out of it, or what is wrong (already worded for the person).</summary>
public sealed record Outcome<T>(T? Value, string? Error, bool NotAllowed = false)
{
    public bool Ok => Error is null && !NotAllowed;

    public static Outcome<T> Success(T value) => new(value, null);

    public static Outcome<T> Fail(string error) => new(default, error);

    /// <summary>The board does not exist or the person may not do this: the page answers 404, like for a board that is not there.</summary>
    public static Outcome<T> Denied() => new(default, null, true);
}

/// <summary>
/// The boards: list, create, change, delete, copy, who they are shared with and the link. Every function checks the right of the person first (<see cref="BoardAccess"/>);
/// nothing here trusts the page. Only the owner changes a board's settings, its members and its link.
/// </summary>
public static class BoardService
{
    public const int NameMax = 120;
    public const int DescriptionMax = 1000;

    public static readonly IReadOnlyList<string> Backgrounds = ["dots", "grid", "lines", "none"];

    /// <summary>The colours of the cursor and name tag a person can choose (dark enough to read on every paper).</summary>
    public static readonly IReadOnlyList<(string Value, string Name)> CursorColors =
    [
        ("#e5484d", "Red"), ("#f76b15", "Orange"), ("#d6a100", "Gold"), ("#30a46c", "Green"), ("#12a594", "Teal"),
        ("#0091ff", "Blue"), ("#6e56cf", "Violet"), ("#d6409f", "Pink"), ("#8d6e63", "Brown"), ("#4c6ef5", "Indigo"),
    ];

    /// <summary>The colours a board's card can have (the yellow first: it is the colour of the app).</summary>
    public static readonly IReadOnlyList<(string Value, string Name)> Colors =
    [
        ("#ffc21f", "Yellow"), ("#ff8a3d", "Orange"), ("#f0503c", "Red"), ("#e0569a", "Pink"), ("#8b5cf6", "Violet"),
        ("#3b82f6", "Blue"), ("#14b8a6", "Teal"), ("#4caf50", "Green"), ("#7c8794", "Grey"),
    ];

    /// <summary>The boards a person sees, filtered, sorted and cut to a page.</summary>
    public static async Task<BoardPage> ListAsync(AppDbContext db, long userId, BoardQuery query, int page, int pageSize, CancellationToken ct = default)
    {
        var visible = BoardAccess.Visible(db, userId);
        var total = await visible.CountAsync(ct);

        var filtered = visible;
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var like = $"%{query.Search.Trim().Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_")}%";
            filtered = filtered.Where(b => EF.Functions.ILike(b.Name, like) || (b.Description != null && EF.Functions.ILike(b.Description, like)));
        }

        filtered = query.Scope switch
        {
            "mine" => filtered.Where(b => b.OwnerId == userId),
            "shared" => filtered.Where(b => b.OwnerId != userId),
            _ => filtered,
        };

        var matching = await filtered.CountAsync(ct);
        var ordered = (query.Sort, query.Descending) switch
        {
            ("name", false) => filtered.OrderBy(b => b.Name.ToLower()).ThenBy(b => b.Id),
            ("name", true) => filtered.OrderByDescending(b => b.Name.ToLower()).ThenBy(b => b.Id),
            ("created", false) => filtered.OrderBy(b => b.CreateDate).ThenBy(b => b.Id),
            ("created", true) => filtered.OrderByDescending(b => b.CreateDate).ThenBy(b => b.Id),
            (_, false) => filtered.OrderBy(b => b.UpdateDate).ThenBy(b => b.Id),
            _ => filtered.OrderByDescending(b => b.UpdateDate).ThenBy(b => b.Id),
        };

        var rows = await ordered.Skip((page - 1) * pageSize).Take(pageSize)
            .Select(b => new
            {
                b.Id,
                b.Name,
                b.Description,
                b.Color,
                OwnerName = b.Owner!.DisplayName,
                b.OwnerId,
                MemberRole = b.Members.Where(m => m.UserId == userId).Select(m => (BoardRole?)m.Role).FirstOrDefault(),
                Members = b.Members.Count,
                b.UpdateDate,
                b.CreateDate,
            })
            .AsNoTracking().ToListAsync(ct);

        return new BoardPage(
            rows.Select(r => new BoardRow(r.Id, r.Name, r.Description, r.Color, r.OwnerName, r.OwnerId == userId ? BoardRole.Owner : r.MemberRole ?? BoardRole.Viewer, r.Members, r.UpdateDate, r.CreateDate)).ToList(),
            total,
            matching);
    }

    /// <summary>The boards a person worked on last (the menu).</summary>
    public static async Task<IReadOnlyList<(long Id, string Name, string Color)>> RecentAsync(AppDbContext db, long userId, int take, CancellationToken ct = default)
    {
        var rows = await BoardAccess.Visible(db, userId).OrderByDescending(b => b.UpdateDate).Take(take).Select(b => new { b.Id, b.Name, b.Color }).AsNoTracking().ToListAsync(ct);
        return rows.Select(r => (r.Id, r.Name, r.Color)).ToList();
    }

    /// <summary>Creates a board owned by <paramref name="userId"/>.</summary>
    public static async Task<Outcome<Board>> CreateAsync(AppDbContext db, long userId, string name, string? description, string? color, string? background, CancellationToken ct = default)
    {
        if (Check(name, description) is { } error)
        {
            return Outcome<Board>.Fail(error);
        }

        var board = new Board
        {
            OwnerId = userId,
            Name = name.Trim(),
            Description = Clean(description),
            Color = Ui.IsColour(color) ? color!.ToLowerInvariant() : Colors[0].Value,
            Background = Backgrounds.Contains(background ?? string.Empty) ? background! : "dots",
            CreateUserId = userId,
        };
        db.Boards.Add(board);
        await db.SaveChangesAsync(ct);
        return Outcome<Board>.Success(board);
    }

    /// <summary>Changes name, description, colour and paper of a board. Owner only.</summary>
    public static async Task<Outcome<Board>> UpdateAsync(AppDbContext db, long userId, long boardId, string name, string? description, string? color, string? background, CancellationToken ct = default)
    {
        if (await BoardAccess.FindAsync(db, Actor.Of(userId), boardId, BoardRole.Owner, track: true, ct: ct) is not { } access)
        {
            return Outcome<Board>.Denied();
        }

        if (Check(name, description) is { } error)
        {
            return Outcome<Board>.Fail(error);
        }

        var board = access.Board;
        board.Name = name.Trim();
        board.Description = Clean(description);
        if (Ui.IsColour(color))
        {
            board.Color = color!.ToLowerInvariant();
        }

        if (Backgrounds.Contains(background ?? string.Empty))
        {
            board.Background = background!;
        }

        await db.SaveChangesAsync(ct);
        return Outcome<Board>.Success(board);
    }

    /// <summary>Deletes a board with everything on it (soft: the housekeeping removes it for good later). Owner only.</summary>
    public static async Task<bool> DeleteAsync(AppDbContext db, long userId, long boardId, CancellationToken ct = default)
    {
        if (await BoardAccess.FindAsync(db, Actor.Of(userId), boardId, BoardRole.Owner, track: true, ct: ct) is not { } access)
        {
            return false;
        }

        db.Boards.Remove(access.Board);
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>A copy of a board (its items, not its members or link) for the person, who owns it. Anybody who may see the original may copy it.</summary>
    public static async Task<Outcome<Board>> DuplicateAsync(AppDbContext db, long userId, long boardId, string copyWord, CancellationToken ct = default)
    {
        if (await BoardAccess.FindAsync(db, Actor.Of(userId), boardId, ct: ct) is not { } access)
        {
            return Outcome<Board>.Denied();
        }

        var name = $"{access.Board.Name} ({copyWord})";
        var copy = new Board
        {
            OwnerId = userId,
            Name = name.Length > NameMax ? name[..NameMax] : name,
            Description = access.Board.Description,
            Color = access.Board.Color,
            Background = access.Board.Background,
            CreateUserId = userId,
        };
        db.Boards.Add(copy);
        await db.SaveChangesAsync(ct);

        var items = await db.BoardItems.AsNoTracking().Where(i => i.BoardId == boardId).ToListAsync(ct);
        var ids = items.ToDictionary(i => i.Uid, _ => Guid.NewGuid());
        foreach (var item in items)
        {
            db.BoardItems.Add(new BoardItem
            {
                BoardId = copy.Id,
                Uid = ids[item.Uid],
                Kind = item.Kind,
                X = item.X,
                Y = item.Y,
                Width = item.Width,
                Height = item.Height,
                Rotation = item.Rotation,
                Z = item.Z,
                Data = BoardItems.RemapReferences(item.Data, ids),
                CreateUserId = userId,
            });
        }

        copy.Revision = 1;
        await db.SaveChangesAsync(ct);
        return Outcome<Board>.Success(copy);
    }

    // ---- members ------------------------------------------------------------------------------------------------------------------

    /// <summary>The people a board is shared with. Owner only.</summary>
    public static async Task<IReadOnlyList<MemberRow>?> MembersAsync(AppDbContext db, long userId, long boardId, CancellationToken ct = default)
    {
        if (await BoardAccess.FindAsync(db, Actor.Of(userId), boardId, BoardRole.Owner, ct: ct) is null)
        {
            return null;
        }

        var rows = await db.BoardMembers.AsNoTracking().Where(m => m.BoardId == boardId)
            .Select(m => new { m.UserId, m.User!.DisplayName, m.User.Email, m.Role }).ToListAsync(ct);
        return rows.OrderBy(r => r.DisplayName, StringComparer.CurrentCultureIgnoreCase).Select(r => new MemberRow(r.UserId, r.DisplayName, r.Email, r.Role)).ToList();
    }

    /// <summary>Shares a board with the person who has this address. Owner only; the role is viewer or editor.</summary>
    public static async Task<Outcome<MemberRow>> AddMemberAsync(AppDbContext db, long userId, long boardId, string email, BoardRole role, CancellationToken ct = default)
    {
        if (await BoardAccess.FindAsync(db, Actor.Of(userId), boardId, BoardRole.Owner, ct: ct) is not { } access)
        {
            return Outcome<MemberRow>.Denied();
        }

        if (role is not (BoardRole.Viewer or BoardRole.Editor))
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.RoleInvalid"));
        }

        var address = AccountService.Normalize(email);
        var person = await db.Users.AsNoTracking().Where(u => u.Email == address && u.IsActive).Select(u => new { u.Id, u.DisplayName, u.Email }).FirstOrDefaultAsync(ct);
        if (person is null)
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.NoAccount"));
        }

        if (person.Id == access.Board.OwnerId)
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.IsOwner"));
        }

        if (await db.BoardMembers.AnyAsync(m => m.BoardId == boardId && m.UserId == person.Id, ct))
        {
            return Outcome<MemberRow>.Fail(Text.T("Members.AlreadyMember"));
        }

        db.BoardMembers.Add(new BoardMember { BoardId = boardId, UserId = person.Id, Role = role, CreateUserId = userId });
        await db.SaveChangesAsync(ct);
        return Outcome<MemberRow>.Success(new MemberRow(person.Id, person.DisplayName, person.Email, role));
    }

    /// <summary>Gives a member another role. Owner only.</summary>
    public static async Task<bool> SetMemberRoleAsync(AppDbContext db, long userId, long boardId, long memberUserId, BoardRole role, CancellationToken ct = default)
    {
        if (role is not (BoardRole.Viewer or BoardRole.Editor)
            || await BoardAccess.FindAsync(db, Actor.Of(userId), boardId, BoardRole.Owner, ct: ct) is null)
        {
            return false;
        }

        var member = await db.BoardMembers.FirstOrDefaultAsync(m => m.BoardId == boardId && m.UserId == memberUserId, ct);
        if (member is null)
        {
            return false;
        }

        member.Role = role;
        await db.SaveChangesAsync(ct);
        return true;
    }

    /// <summary>Takes a person off a board: the owner removes anybody, a member removes themselves (leaves).</summary>
    public static async Task<bool> RemoveMemberAsync(AppDbContext db, long userId, long boardId, long memberUserId, CancellationToken ct = default)
    {
        var board = await db.Boards.AsNoTracking().FirstOrDefaultAsync(b => b.Id == boardId, ct);
        if (board is null || (board.OwnerId != userId && memberUserId != userId))
        {
            return false;
        }

        var removed = await db.BoardMembers.Where(m => m.BoardId == boardId && m.UserId == memberUserId).ExecuteDeleteAsync(ct);
        return removed > 0;
    }

    // ---- the link -----------------------------------------------------------------------------------------------------------------

    /// <summary>Switches the link of a board (off, view, edit) and, when asked, makes a new secret so the old address stops working. Owner only.</summary>
    public static async Task<Board?> SetLinkAsync(AppDbContext db, long userId, long boardId, LinkMode mode, bool renew, CancellationToken ct = default)
    {
        if (await BoardAccess.FindAsync(db, Actor.Of(userId), boardId, BoardRole.Owner, track: true, ct: ct) is not { } access)
        {
            return null;
        }

        access.Board.LinkMode = mode;
        if (renew)
        {
            access.Board.ShareToken = Guid.NewGuid();
        }

        await db.SaveChangesAsync(ct);
        return access.Board;
    }

    /// <summary>Does the person want a mail when a board is shared with them?</summary>
    public static async Task<bool> WantsShareMailAsync(AppDbContext db, long userId, CancellationToken ct = default)
        => await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.MailOnShare).FirstOrDefaultAsync(ct);

    /// <summary>The language of a person (their account, else the default of the app): the language their mails are written in.</summary>
    public static async Task<string> LanguageOfAsync(AppDbContext db, long userId, CancellationToken ct = default)
        => Languages.Normalize(await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.Language).FirstOrDefaultAsync(ct));

    private static string? Check(string name, string? description)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return Text.T("Common.NameRequired");
        }

        if (name.Trim().Length > NameMax)
        {
            return Text.T("Boards.NameTooLong", NameMax);
        }

        return description is { Length: > DescriptionMax } ? Text.T("Boards.DescriptionTooLong", DescriptionMax) : null;
    }

    private static string? Clean(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();
}
