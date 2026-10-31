using MatBoard.Controls;
using MatBoard.Data;
using MatBoard.Localization;
using MatBoard.Services;
using MatBoard.Services.Boards;
using MatBoard.Services.Mail;
using Microsoft.AspNetCore.Mvc;

namespace MatBoard.Pages.Boards;

/// <summary>Who a board is shared with: add a person by their address, give them another role, take them off. Only the owner (the business layer checks it again).</summary>
public sealed class MembersModel(AppDbContext db, BoardRooms rooms, MailService mail, InstanceService instance) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long Id { get; set; }

    [BindProperty] public string Email { get; set; } = string.Empty;

    [BindProperty] public BoardRole NewRole { get; set; } = BoardRole.Editor;

    public string BoardName { get; private set; } = string.Empty;

    public string OwnerName { get; private set; } = string.Empty;

    public string OwnerEmail { get; private set; } = string.Empty;

    public IReadOnlyList<MemberRow> Members { get; private set; } = [];

    public List<Choice> Roles { get; } =
    [
        new(nameof(BoardRole.Editor), Text.T("Boards.Role.Editor")),
        new(nameof(BoardRole.Viewer), Text.T("Boards.Role.Viewer")),
    ];

    public async Task<IActionResult> OnGetAsync() => await LoadAsync() ? Page() : NotFound();

    public async Task<IActionResult> OnPostAddAsync()
    {
        var added = await BoardService.AddMemberAsync(db, UserId, Id, Email, NewRole);
        if (added.NotAllowed)
        {
            return NotFound();
        }

        if (!added.Ok)
        {
            ModelState.AddModelError(nameof(Email), added.Error!);
            await LoadAsync();
            return Page();
        }

        await TellAsync(added.Value!);
        Flash(Text.T("Members.Added", added.Value!.Name));
        return LocalRedirect($"/Boards/Members?id={Id}");
    }

    public async Task<IActionResult> OnPostRoleAsync(long memberId, BoardRole role)
    {
        if (!await BoardService.SetMemberRoleAsync(db, UserId, Id, memberId, role))
        {
            return NotFound();
        }

        await rooms.RevalidateAsync(Id);
        Flash(Text.T("Common.Saved"));
        return LocalRedirect($"/Boards/Members?id={Id}");
    }

    public async Task<IActionResult> OnPostRemoveAsync(long memberId)
    {
        if (!await BoardService.RemoveMemberAsync(db, UserId, Id, memberId))
        {
            return NotFound();
        }

        await rooms.RevalidateAsync(Id);
        Flash(Text.T("Members.Removed"));
        return LocalRedirect($"/Boards/Members?id={Id}");
    }

    private async Task<bool> LoadAsync()
    {
        if (await BoardAccess.FindAsync(db, Actor.Of(UserId), Id, BoardRole.Owner) is not { } access
            || await BoardService.MembersAsync(db, UserId, Id) is not { } members)
        {
            return false;
        }

        BoardName = access.Board.Name;
        OwnerName = Me.DisplayName;
        OwnerEmail = Me.Snapshot!.Email;
        Members = members;
        return true;
    }

    /// <summary>A mail to the person the board was shared with, when the installation can send mail and the person wants it. Words in the language of the person.</summary>
    private async Task TellAsync(MemberRow person)
    {
        if (!mail.IsConfigured || !await BoardService.WantsShareMailAsync(db, person.UserId))
        {
            return;
        }

        var (_, publicUrl) = await instance.SettingsAsync();
        var origin = publicUrl ?? $"{Request.Scheme}://{Request.Host}";
        var language = await BoardService.LanguageOfAsync(db, person.UserId);
        var board = BoardName;
        var sender = Me.DisplayName;
        var role = person.Role;
        var text = Languages.In(language, () => Text.T(role == BoardRole.Editor ? "Mail.Share.Editor" : "Mail.Share.Viewer", sender, board, $"{origin}/Boards/Canvas/{Id}"));
        var subject = Languages.In(language, () => Text.T("Mail.Share.Subject", sender, board));
        mail.Enqueue(new OutgoingMail(person.Email, person.Name, subject, text));
    }
}
