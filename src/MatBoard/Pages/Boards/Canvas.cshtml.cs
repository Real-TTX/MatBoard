using MatBoard.Data;
using MatBoard.Services;
using MatBoard.Services.Boards;
using Microsoft.AspNetCore.Mvc;

namespace MatBoard.Pages.Boards;

/// <summary>A board, opened by a person who is signed in and may see it (owner, member). The content comes from the scripts: the page only says who looks.</summary>
public sealed class CanvasModel(AppDbContext db) : AppPageModel
{
    public BoardViewModel Board { get; private set; } = null!;

    public async Task<IActionResult> OnGetAsync(long id)
    {
        if (await BoardAccess.FindAsync(db, Actor.Of(UserId), id) is not { } access)
        {
            return NotFound();
        }

        Board = new BoardViewModel(access.Board.Id, access.Board.Name, access.Role, access.Board.Background, string.Empty, false, Me.DisplayName, Me.TimeZone);
        ViewData["ActiveBoard"] = id;
        return Page();
    }
}
