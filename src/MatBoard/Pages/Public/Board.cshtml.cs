using MatBoard.Data;
using MatBoard.Services;
using MatBoard.Services.Boards;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace MatBoard.Pages.Public;

/// <summary>
/// A board opened through its link (<c>/b/&lt;secret&gt;</c>), by anybody: a guest asks for a name and works under it, a signed-in person works as themselves (and keeps
/// the better of their own right and the link's). A link that is off, or wrong, answers 404 exactly like a board that is not there.
/// </summary>
public sealed class BoardModel(AppDbContext db, CurrentUser me) : PageModel
{
    public BoardViewModel Board { get; private set; } = null!;

    public async Task<IActionResult> OnGetAsync(Guid token)
    {
        if (await BoardAccess.FindByLinkAsync(db, token) is not { } viaLink)
        {
            return NotFound();
        }

        var actor = new Actor(me.Id, token);
        var access = await BoardAccess.FindAsync(db, actor, viaLink.Board.Id);
        if (access is null)
        {
            return NotFound();
        }

        Board = new BoardViewModel(access.Board.Id, access.Board.Name, access.Role, access.Board.Background, token.ToString(), !me.IsAuthenticated, me.DisplayName, me.TimeZone);
        Response.Headers.CacheControl = "no-store";
        return Page();
    }
}
