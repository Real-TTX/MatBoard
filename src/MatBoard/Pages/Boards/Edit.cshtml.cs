using System.Text.Json.Nodes;
using MatBoard.Controls;
using MatBoard.Data;
using MatBoard.Localization;
using MatBoard.Services;
using MatBoard.Services.Boards;
using Microsoft.AspNetCore.Mvc;

namespace MatBoard.Pages.Boards;

/// <summary>Create a board, change its name, colour and paper, delete it. Only the owner may change an existing board (the business layer checks it again).</summary>
public sealed class EditModel(AppDbContext db) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long? Id { get; set; }

    [BindProperty] public string Name { get; set; } = string.Empty;

    [BindProperty] public string Description { get; set; } = string.Empty;

    [BindProperty] public string Color { get; set; } = BoardService.Colors[0].Value;

    [BindProperty] public string Background { get; set; } = "dots";

    public bool IsNew => Id is null;

    public List<Choice> Papers { get; } = BoardService.Backgrounds.Select(b => new Choice(b, Text.T("Boards.Paper." + b))).ToList();

    public async Task<IActionResult> OnGetAsync()
    {
        if (Id is { } id)
        {
            if (await BoardAccess.FindAsync(db, Actor.Of(UserId), id, BoardRole.Owner) is not { } access)
            {
                return NotFound();
            }

            Name = access.Board.Name;
            Description = access.Board.Description ?? string.Empty;
            Color = access.Board.Color;
            Background = access.Board.Background;
        }

        return Page();
    }

    public async Task<IActionResult> OnPostAsync([FromServices] BoardRooms rooms)
    {
        if (Id is { } id)
        {
            var saved = await BoardService.UpdateAsync(db, UserId, id, Name, Description, Color, Background);
            if (saved.NotAllowed)
            {
                return NotFound();
            }

            if (!saved.Ok)
            {
                ModelState.AddModelError(nameof(Name), saved.Error!);
                return Page();
            }

            await rooms.NotifyAsync(id, new JsonObject { ["t"] = "board", ["name"] = saved.Value!.Name, ["background"] = saved.Value.Background });
            Flash(Text.T("Common.Saved"));
            return LocalRedirect("/Boards");
        }

        var created = await BoardService.CreateAsync(db, UserId, Name, Description, Color, Background);
        if (!created.Ok)
        {
            ModelState.AddModelError(nameof(Name), created.Error!);
            return Page();
        }

        Flash(Text.T("Common.CreatedNamed", created.Value!.Name));
        return LocalRedirect($"/Boards/Canvas/{created.Value.Id}");
    }

    public async Task<IActionResult> OnPostDeleteAsync([FromServices] BoardRooms rooms)
    {
        if (Id is not { } id || !await BoardService.DeleteAsync(db, UserId, id))
        {
            return NotFound();
        }

        await rooms.RevalidateAsync(id);
        Flash(Text.T("Common.DeletedNamed", Name));
        return LocalRedirect("/Boards");
    }
}
