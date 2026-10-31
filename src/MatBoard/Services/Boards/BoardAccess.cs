using MatBoard.Data;
using Microsoft.EntityFrameworkCore;

namespace MatBoard.Services.Boards;

/// <summary>
/// Who asks: a signed-in person, somebody who holds the link of a board (a guest, <see cref="UserId"/> is null) or both (a person who opens the link of a board
/// they are a member of gets the better of the two).
/// </summary>
public readonly record struct Actor(long? UserId, Guid? LinkToken = null)
{
    public static Actor Of(long userId) => new(userId);

    public static Actor Guest(Guid token) => new(null, token);

    public Actor WithLink(Guid token) => this with { LinkToken = token };
}

/// <summary>A board together with what the asking person may do with it.</summary>
public sealed record BoardAccessInfo(Board Board, BoardRole Role)
{
    public bool CanEdit => Role >= BoardRole.Editor;

    public bool IsOwner => Role == BoardRole.Owner;
}

/// <summary>
/// The one place that decides who may see and change a board. Every function of the business layer starts here. A board the person may not see answers <c>null</c>
/// exactly like one that does not exist, so nobody learns which boards exist. The administrator of the installation has no access to boards of others: a board is
/// private to its owner and the people it is shared with.
/// </summary>
public static class BoardAccess
{
    /// <summary>
    /// The board with the role of <paramref name="actor"/> on it, or <c>null</c> when it does not exist or the person's role is below <paramref name="minimum"/>.
    /// The returned board is not tracked unless <paramref name="track"/> is set.
    /// </summary>
    public static async Task<BoardAccessInfo?> FindAsync(AppDbContext db, Actor actor, long boardId, BoardRole minimum = BoardRole.Viewer, bool track = false, CancellationToken ct = default)
    {
        var query = track ? db.Boards : db.Boards.AsNoTracking();
        var board = await query.FirstOrDefaultAsync(b => b.Id == boardId, ct);
        if (board is null)
        {
            return null;
        }

        var role = await RoleAsync(db, actor, board, ct);
        return role >= minimum && role > BoardRole.None ? new BoardAccessInfo(board, role) : null;
    }

    /// <summary>The board a link opens (with the role the link gives), or <c>null</c> when no board has this link or it is switched off.</summary>
    public static async Task<BoardAccessInfo?> FindByLinkAsync(AppDbContext db, Guid token, CancellationToken ct = default)
    {
        var board = await db.Boards.AsNoTracking().FirstOrDefaultAsync(b => b.ShareToken == token && b.LinkMode != LinkMode.Off, ct);
        return board is null ? null : new BoardAccessInfo(board, LinkRole(board.LinkMode));
    }

    /// <summary>The role of the actor on a board: the owner, a member, the link, whichever is best.</summary>
    public static async Task<BoardRole> RoleAsync(AppDbContext db, Actor actor, Board board, CancellationToken ct = default)
    {
        var role = BoardRole.None;
        if (actor.UserId is { } userId)
        {
            if (board.OwnerId == userId)
            {
                return BoardRole.Owner;
            }

            var member = await db.BoardMembers.AsNoTracking().Where(m => m.BoardId == board.Id && m.UserId == userId).Select(m => (BoardRole?)m.Role).FirstOrDefaultAsync(ct);
            if (member is { } memberRole)
            {
                role = memberRole;
            }
        }

        if (actor.LinkToken is { } token && token == board.ShareToken)
        {
            var viaLink = LinkRole(board.LinkMode);
            if (viaLink > role)
            {
                role = viaLink;
            }
        }

        return role;
    }

    /// <summary>The role a link gives.</summary>
    public static BoardRole LinkRole(LinkMode mode) => mode switch
    {
        LinkMode.View => BoardRole.Viewer,
        LinkMode.Edit => BoardRole.Editor,
        _ => BoardRole.None,
    };

    /// <summary>The boards a person owns or is a member of.</summary>
    public static IQueryable<Board> Visible(AppDbContext db, long userId)
        => db.Boards.Where(b => b.OwnerId == userId || b.Members.Any(m => m.UserId == userId));
}
