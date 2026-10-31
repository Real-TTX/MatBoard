using MatBoard.Data;
using MatBoard.Localization;
using MatBoard.Services;
using MatBoard.Services.Boards;
using Microsoft.AspNetCore.Mvc;

namespace MatBoard.Pages.Boards;

/// <summary>The boards of the signed-in person: their own and the ones shared with them. Search, filter and sort are in the toolbar above.</summary>
public sealed class IndexModel(AppDbContext db) : AppPageModel
{
    private const int PageSize = 25;
    private static readonly string[] Sorts = ["changed", "name", "created"];

    public ToolbarModel Toolbar { get; private set; } = null!;

    public PagerModel Pager { get; private set; } = null!;

    public BoardPage Listing { get; private set; } = new([], 0, 0);

    public string Zone => Me.TimeZone;

    public async Task OnGetAsync()
    {
        var search = ListQuery.Text(Request, "q");
        var scope = ListQuery.Text(Request, "scope") is "mine" or "shared" ? ListQuery.Text(Request, "scope") : null;
        var sort = ListQuery.Text(Request, "sort") is { } s && Sorts.Contains(s) ? s : "changed";
        var desc = ListQuery.Descending(Request, byDefault: sort != "name");
        var page = ListQuery.Page(Request);

        Listing = await BoardService.ListAsync(db, UserId, new BoardQuery(search, scope, sort, desc), page, PageSize);
        Toolbar = new ToolbarModel
        {
            Id = "boards",
            Action = "/Boards",
            Label = Text.T("Boards.Title"),
            Search = search,
            SearchField = true,
            SearchPlaceholder = Text.T("Boards.Search"),
            Filters = [new FilterField("scope", Text.T("Boards.Col.Owner"), [new("mine", Text.T("Boards.Mine")), new("shared", Text.T("Boards.Shared"))], scope)],
            SortOptions = [new("changed", Text.T("Boards.Col.Changed")), new("name", Text.T("Common.Name")), new("created", Text.T("Boards.Created"))],
            Sort = sort,
            Descending = desc,
            DefaultSort = "changed",
            DefaultDescending = true,
            Total = Listing.Total,
            Matching = Listing.Matching,
            Noun = Text.T("Boards.Many"),
            NounOne = Text.T("Boards.One"),
        };
        Pager = new PagerModel { Page = page, PageSize = PageSize, Total = Listing.Matching, Url = Toolbar.UrlWithPage };
    }

    public async Task<IActionResult> OnPostDuplicateAsync(long id)
    {
        var copy = await BoardService.DuplicateAsync(db, UserId, id, Text.T("Boards.CopyWord"));
        if (!copy.Ok)
        {
            return NotFound();
        }

        Flash(Text.T("Boards.Duplicated", copy.Value!.Name));
        return LocalRedirect($"/Boards/Canvas/{copy.Value.Id}");
    }

    public async Task<IActionResult> OnPostLeaveAsync(long id, [FromServices] BoardRooms rooms)
    {
        if (!await BoardService.RemoveMemberAsync(db, UserId, id, UserId))
        {
            return NotFound();
        }

        await rooms.RevalidateAsync(id);
        Flash(Text.T("Boards.Left"));
        return LocalRedirect("/Boards");
    }
}
