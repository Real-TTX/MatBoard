using MatBoard.Controls;
using MatBoard.Data;
using MatBoard.Localization;
using MatBoard.Services;
using MatBoard.Services.Boards;
using Microsoft.AspNetCore.Mvc;

namespace MatBoard.Pages.Boards;

/// <summary>The link of a board: who may open it (nobody, anybody to look, anybody to work on it) and a new secret when the old address got out. Only the owner.</summary>
public sealed class ShareModel(AppDbContext db, BoardRooms rooms, InstanceService instance) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long Id { get; set; }

    [BindProperty] public string Mode { get; set; } = nameof(LinkMode.Off);

    public string BoardName { get; private set; } = string.Empty;

    public string LinkUrl { get; private set; } = string.Empty;

    public List<Choice> Modes { get; } =
    [
        new(nameof(LinkMode.Off), Text.T("Share.Mode.Off")),
        new(nameof(LinkMode.View), Text.T("Share.Mode.View")),
        new(nameof(LinkMode.Edit), Text.T("Share.Mode.Edit")),
    ];

    public async Task<IActionResult> OnGetAsync() => await LoadAsync() ? Page() : NotFound();

    public async Task<IActionResult> OnPostAsync()
    {
        var mode = Enum.TryParse<LinkMode>(Mode, out var parsed) ? parsed : LinkMode.Off;
        return await ChangeAsync(mode, renew: false);
    }

    public async Task<IActionResult> OnPostRenewAsync()
    {
        var mode = Enum.TryParse<LinkMode>(Mode, out var parsed) ? parsed : LinkMode.Off;
        return await ChangeAsync(mode, renew: true);
    }

    private async Task<IActionResult> ChangeAsync(LinkMode mode, bool renew)
    {
        if (await BoardService.SetLinkAsync(db, UserId, Id, mode, renew) is null)
        {
            return NotFound();
        }

        // everybody who came in through the old link or the old setting is asked again
        await rooms.RevalidateAsync(Id);
        Flash(Text.T(renew ? "Share.Renewed" : "Common.Saved"));
        return LocalRedirect($"/Boards/Share?id={Id}");
    }

    private async Task<bool> LoadAsync()
    {
        if (await BoardAccess.FindAsync(db, Actor.Of(UserId), Id, BoardRole.Owner) is not { } access)
        {
            return false;
        }

        BoardName = access.Board.Name;
        Mode = access.Board.LinkMode.ToString();
        var (_, publicUrl) = await instance.SettingsAsync();
        LinkUrl = $"{publicUrl ?? $"{Request.Scheme}://{Request.Host}"}/b/{access.Board.ShareToken}";
        return true;
    }
}
