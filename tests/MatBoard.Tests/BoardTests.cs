using System.Text.Json.Nodes;
using MatBoard.Data;
using MatBoard.Services.Boards;
using Microsoft.EntityFrameworkCore;

namespace MatBoard.Tests;

/// <summary>Who may see and change a board, and what the business layer does with boards. Needs PostgreSQL (see <see cref="DbFactAttribute"/>).</summary>
public sealed class BoardAccessTests
{
    [DbFact]
    public async Task Owner_member_link_and_stranger_get_the_right_role()
    {
        await using var t = await TestDatabase.CreateAsync();
        var owner = await t.AddUserAsync("Olga");
        var editor = await t.AddUserAsync("Eddie");
        var viewer = await t.AddUserAsync("Vera");
        var stranger = await t.AddUserAsync("Sam");
        var admin = await t.AddUserAsync("Ada", UserRole.Admin);
        var board = (await BoardService.CreateAsync(t.Db, owner.Id, "Plan", null, null, null)).Value!;
        Assert.True((await BoardService.AddMemberAsync(t.Db, owner.Id, board.Id, "eddie@example.com", BoardRole.Editor)).Ok);
        Assert.True((await BoardService.AddMemberAsync(t.Db, owner.Id, board.Id, "vera@example.com", BoardRole.Viewer)).Ok);

        Assert.Equal(BoardRole.Owner, (await BoardAccess.FindAsync(t.Db, Actor.Of(owner.Id), board.Id))!.Role);
        Assert.Equal(BoardRole.Editor, (await BoardAccess.FindAsync(t.Db, Actor.Of(editor.Id), board.Id))!.Role);
        Assert.Equal(BoardRole.Viewer, (await BoardAccess.FindAsync(t.Db, Actor.Of(viewer.Id), board.Id))!.Role);
        Assert.Null(await BoardAccess.FindAsync(t.Db, Actor.Of(stranger.Id), board.Id));
        Assert.Null(await BoardAccess.FindAsync(t.Db, Actor.Of(admin.Id), board.Id));   // an administrator of the installation has no access to the boards of others
        Assert.Null(await BoardAccess.FindAsync(t.Db, Actor.Of(editor.Id), board.Id, BoardRole.Owner));

        // the link
        var guest = Actor.Guest(board.ShareToken);
        Assert.Null(await BoardAccess.FindAsync(t.Db, guest, board.Id));
        await BoardService.SetLinkAsync(t.Db, owner.Id, board.Id, LinkMode.View, renew: false);
        Assert.Equal(BoardRole.Viewer, (await BoardAccess.FindAsync(t.Db, guest, board.Id))!.Role);
        await BoardService.SetLinkAsync(t.Db, owner.Id, board.Id, LinkMode.Edit, renew: false);
        Assert.Equal(BoardRole.Editor, (await BoardAccess.FindAsync(t.Db, guest, board.Id))!.Role);
        Assert.Equal(BoardRole.Editor, (await BoardAccess.FindAsync(t.Db, Actor.Of(viewer.Id).WithLink(board.ShareToken), board.Id))!.Role);   // the better of the two
        var old = board.ShareToken;
        var renewed = (await BoardService.SetLinkAsync(t.Db, owner.Id, board.Id, LinkMode.Edit, renew: true))!;
        Assert.NotEqual(old, renewed.ShareToken);
        Assert.Null(await BoardAccess.FindAsync(t.Db, Actor.Guest(old), board.Id));
        Assert.Null(await BoardAccess.FindByLinkAsync(t.Db, old));
        Assert.NotNull(await BoardAccess.FindByLinkAsync(t.Db, renewed.ShareToken));
    }

    [DbFact]
    public async Task Only_the_owner_changes_settings_members_and_link()
    {
        await using var t = await TestDatabase.CreateAsync();
        var owner = await t.AddUserAsync("Olga");
        var editor = await t.AddUserAsync("Eddie");
        var board = (await BoardService.CreateAsync(t.Db, owner.Id, "Plan", null, null, null)).Value!;
        await BoardService.AddMemberAsync(t.Db, owner.Id, board.Id, "eddie@example.com", BoardRole.Editor);

        Assert.True((await BoardService.UpdateAsync(t.Db, editor.Id, board.Id, "Hacked", null, null, null)).NotAllowed);
        Assert.False(await BoardService.DeleteAsync(t.Db, editor.Id, board.Id));
        Assert.True((await BoardService.AddMemberAsync(t.Db, editor.Id, board.Id, "olga@example.com", BoardRole.Editor)).NotAllowed);
        Assert.Null(await BoardService.MembersAsync(t.Db, editor.Id, board.Id));
        Assert.Null(await BoardService.SetLinkAsync(t.Db, editor.Id, board.Id, LinkMode.Edit, false));
        Assert.False(await BoardService.RemoveMemberAsync(t.Db, editor.Id, board.Id, owner.Id));
        Assert.Equal("Plan", (await t.Db.Boards.AsNoTracking().FirstAsync(b => b.Id == board.Id)).Name);

        // a member may leave
        Assert.True(await BoardService.RemoveMemberAsync(t.Db, editor.Id, board.Id, editor.Id));
        Assert.Null(await BoardAccess.FindAsync(t.Db, Actor.Of(editor.Id), board.Id));
        t.Db.ChangeTracker.Clear();   // a request has a context of its own: nothing tracked from before
        Assert.True(await BoardService.DeleteAsync(t.Db, owner.Id, board.Id));
        Assert.Null(await BoardAccess.FindAsync(t.Db, Actor.Of(owner.Id), board.Id));
    }

    [DbFact]
    public async Task Members_are_checked_and_the_list_filters()
    {
        await using var t = await TestDatabase.CreateAsync();
        var owner = await t.AddUserAsync("Olga");
        var other = await t.AddUserAsync("Otto");
        var mine = (await BoardService.CreateAsync(t.Db, owner.Id, "Alpha plan", "first", null, null)).Value!;
        var theirs = (await BoardService.CreateAsync(t.Db, other.Id, "Beta review", null, null, null)).Value!;
        await BoardService.AddMemberAsync(t.Db, other.Id, theirs.Id, "olga@example.com", BoardRole.Viewer);

        Assert.False((await BoardService.AddMemberAsync(t.Db, owner.Id, mine.Id, "nobody@example.com", BoardRole.Editor)).Ok);
        Assert.False((await BoardService.AddMemberAsync(t.Db, owner.Id, mine.Id, "olga@example.com", BoardRole.Editor)).Ok);   // the owner
        Assert.False((await BoardService.AddMemberAsync(t.Db, owner.Id, mine.Id, "otto@example.com", BoardRole.Owner)).Ok);    // not a role to give
        Assert.True((await BoardService.AddMemberAsync(t.Db, owner.Id, mine.Id, "otto@example.com", BoardRole.Editor)).Ok);
        Assert.False((await BoardService.AddMemberAsync(t.Db, owner.Id, mine.Id, "otto@example.com", BoardRole.Editor)).Ok);   // twice

        var all = await BoardService.ListAsync(t.Db, owner.Id, new BoardQuery(null, null, "name", false), 1, 25);
        Assert.Equal(["Alpha plan", "Beta review"], all.Rows.Select(r => r.Name));
        Assert.Equal(2, all.Total);
        Assert.Equal(["Alpha plan"], (await BoardService.ListAsync(t.Db, owner.Id, new BoardQuery(null, "mine", "name", false), 1, 25)).Rows.Select(r => r.Name));
        var shared = (await BoardService.ListAsync(t.Db, owner.Id, new BoardQuery(null, "shared", "name", false), 1, 25)).Rows.Single();
        Assert.Equal(BoardRole.Viewer, shared.Role);
        Assert.Empty((await BoardService.ListAsync(t.Db, owner.Id, new BoardQuery("100%", null, "name", false), 1, 25)).Rows);   // % is a letter, not a wildcard
        Assert.Equal(["Beta review"], (await BoardService.ListAsync(t.Db, owner.Id, new BoardQuery("BETA", null, "name", false), 1, 25)).Rows.Select(r => r.Name));
    }
}

public sealed class BoardItemTests
{
    private static JsonObject Add(Guid id, string kind = "sticky", JsonObject? d = null)
        => new() { ["o"] = "add", ["i"] = new JsonObject { ["id"] = id.ToString(), ["k"] = kind, ["x"] = 10, ["y"] = 20, ["w"] = 200, ["h"] = 100, ["z"] = 1, ["d"] = d ?? new JsonObject { ["text"] = "Hi", ["fill"] = "#fff2a8" } } };

    [DbFact]
    public async Task Add_update_merge_and_delete_are_stored_and_counted()
    {
        await using var t = await TestDatabase.CreateAsync();
        var owner = await t.AddUserAsync("Olga");
        var board = (await BoardService.CreateAsync(t.Db, owner.Id, "Plan", null, null, null)).Value!;
        var actor = Actor.Of(owner.Id);
        var id = Guid.NewGuid();

        var added = await BoardItems.ApplyAsync(t.Db, actor, board.Id, [Add(id)]);
        Assert.True(added.Allowed);
        Assert.Single(added.Accepted);
        Assert.Equal(1, added.Revision);

        // two people change different keys of the data: both survive (merged), a null removes a key
        await BoardItems.ApplyAsync(t.Db, actor, board.Id, [JsonNode.Parse($$$"""{"o":"upd","id":"{{{id}}}","x":55,"d":{"fill":"#a5d8ff"}}""")]);
        var second = await BoardItems.ApplyAsync(t.Db, actor, board.Id, [JsonNode.Parse($$$"""{"o":"upd","id":"{{{id}}}","d":{"text":"Changed","fs":30}}""")]);
        Assert.Equal(3, second.Revision);
        var item = (await BoardItems.LoadAsync(t.Db, actor, board.Id))!.Items.Single();
        Assert.Equal(55, item.X);
        Assert.Equal("#a5d8ff", item.D["fill"]!.GetValue<string>());
        Assert.Equal("Changed", item.D["text"]!.GetValue<string>());
        await BoardItems.ApplyAsync(t.Db, actor, board.Id, [JsonNode.Parse($$$"""{"o":"upd","id":"{{{id}}}","d":{"fs":null}}""")]);
        Assert.False((await BoardItems.LoadAsync(t.Db, actor, board.Id))!.Items.Single().D.ContainsKey("fs"));

        // adding the same id again is an upsert (a replay after a reconnect)
        await BoardItems.ApplyAsync(t.Db, actor, board.Id, [Add(id)]);
        Assert.Single((await BoardItems.LoadAsync(t.Db, actor, board.Id))!.Items);

        await BoardItems.ApplyAsync(t.Db, actor, board.Id, [JsonNode.Parse($$$"""{"o":"del","id":"{{{id}}}"}""")]);
        Assert.Empty((await BoardItems.LoadAsync(t.Db, actor, board.Id))!.Items);
    }

    [DbFact]
    public async Task A_viewer_a_stranger_and_bad_data_change_nothing()
    {
        await using var t = await TestDatabase.CreateAsync();
        var owner = await t.AddUserAsync("Olga");
        var viewer = await t.AddUserAsync("Vera");
        var stranger = await t.AddUserAsync("Sam");
        var board = (await BoardService.CreateAsync(t.Db, owner.Id, "Plan", null, null, null)).Value!;
        await BoardService.AddMemberAsync(t.Db, owner.Id, board.Id, "vera@example.com", BoardRole.Viewer);

        Assert.False((await BoardItems.ApplyAsync(t.Db, Actor.Of(viewer.Id), board.Id, [Add(Guid.NewGuid())])).Allowed);
        Assert.False((await BoardItems.ApplyAsync(t.Db, Actor.Of(stranger.Id), board.Id, [Add(Guid.NewGuid())])).Allowed);
        Assert.False((await BoardItems.ApplyAsync(t.Db, Actor.Guest(board.ShareToken), board.Id, [Add(Guid.NewGuid())])).Allowed);
        Assert.Null(await BoardItems.LoadAsync(t.Db, Actor.Of(stranger.Id), board.Id));

        var bad = new JsonNode?[]
        {
            Add(Guid.NewGuid(), "script"),
            Add(Guid.NewGuid(), "sticky", new JsonObject { ["fill"] = "red;background:url(x)" }),
            Add(Guid.NewGuid(), "image", new JsonObject { ["src"] = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }),
            Add(Guid.NewGuid(), "image", new JsonObject { ["src"] = "https://example.com/x.png" }),
            JsonNode.Parse("""{"o":"add","i":{"id":"nope","k":"sticky","x":0,"y":0,"w":1,"h":1,"d":{}}}"""),
            JsonNode.Parse("{\"o\":\"add\",\"i\":{\"id\":\"" + Guid.NewGuid() + "\",\"k\":\"sticky\",\"x\":1e30,\"y\":0,\"w\":1,\"h\":1,\"d\":{}}}"),
            JsonNode.Parse("""{"o":"explode"}"""),
        };
        var result = await BoardItems.ApplyAsync(t.Db, Actor.Of(owner.Id), board.Id, bad);
        Assert.True(result.Allowed);
        Assert.Empty(result.Accepted);
        Assert.Equal(bad.Length, result.Rejected.Count);
        Assert.Empty((await BoardItems.LoadAsync(t.Db, Actor.Of(owner.Id), board.Id))!.Items);
    }

    [DbFact]
    public async Task Comments_and_stamps_are_checked()
    {
        await using var t = await TestDatabase.CreateAsync();
        var owner = await t.AddUserAsync("Olga");
        var board = (await BoardService.CreateAsync(t.Db, owner.Id, "Plan", null, null, null)).Value!;
        var actor = Actor.Of(owner.Id);
        JsonObject Thread(params string[] texts) => new() { ["msgs"] = new JsonArray([.. texts.Select(x => (JsonNode)new JsonObject { ["a"] = "Olga", ["t"] = x })]) };

        var good = await BoardItems.ApplyAsync(t.Db, actor, board.Id, [Add(Guid.NewGuid(), "comment", Thread("Looks good")), Add(Guid.NewGuid(), "stamp", new JsonObject { ["e"] = "+1" })]);
        Assert.Equal(2, good.Accepted.Count);

        var bad = await BoardItems.ApplyAsync(t.Db, actor, board.Id,
        [
            Add(Guid.NewGuid(), "comment", Thread()),
            Add(Guid.NewGuid(), "comment", Thread(new string('x', 2001))),
            Add(Guid.NewGuid(), "comment", new JsonObject { ["msgs"] = new JsonArray(new JsonObject { ["a"] = new string('a', 61), ["t"] = "Hi" }) }),
            Add(Guid.NewGuid(), "stamp", new JsonObject { ["e"] = "" }),
            Add(Guid.NewGuid(), "stamp", new JsonObject()),
        ]);
        Assert.Empty(bad.Accepted);
        Assert.Equal(5, bad.Rejected.Count);
    }

    [DbFact]
    public async Task A_locked_item_only_accepts_being_unlocked()
    {
        await using var t = await TestDatabase.CreateAsync();
        var owner = await t.AddUserAsync("Olga");
        var board = (await BoardService.CreateAsync(t.Db, owner.Id, "Plan", null, null, null)).Value!;
        var actor = Actor.Of(owner.Id);
        var id = Guid.NewGuid();
        await BoardItems.ApplyAsync(t.Db, actor, board.Id, [Add(id)]);
        await BoardItems.ApplyAsync(t.Db, actor, board.Id, [JsonNode.Parse($$$"""{"o":"upd","id":"{{{id}}}","d":{"lock":true}}""")]);

        var refused = await BoardItems.ApplyAsync(t.Db, actor, board.Id,
        [
            JsonNode.Parse($$$"""{"o":"upd","id":"{{{id}}}","x":500}"""),
            JsonNode.Parse($$$"""{"o":"upd","id":"{{{id}}}","d":{"text":"Changed","lock":null}}"""),
            Add(id),
            JsonNode.Parse($$$"""{"o":"del","id":"{{{id}}}"}"""),
        ]);
        Assert.Empty(refused.Accepted);
        Assert.All(refused.Rejected, r => Assert.Equal("locked", r));
        var item = (await BoardItems.LoadAsync(t.Db, actor, board.Id))!.Items.Single();
        Assert.Equal(10, item.X);
        Assert.Equal("Hi", item.D["text"]!.GetValue<string>());

        var unlocked = await BoardItems.ApplyAsync(t.Db, actor, board.Id, [JsonNode.Parse($$$"""{"o":"upd","id":"{{{id}}}","d":{"lock":null}}""")]);
        Assert.Single(unlocked.Accepted);
        Assert.Single((await BoardItems.ApplyAsync(t.Db, actor, board.Id, [JsonNode.Parse($$$"""{"o":"upd","id":"{{{id}}}","x":500}""")])).Accepted);
    }

    [DbFact]
    public async Task Duplicate_copies_the_items_and_connects_the_copies()
    {
        await using var t = await TestDatabase.CreateAsync();
        var owner = await t.AddUserAsync("Olga");
        var board = (await BoardService.CreateAsync(t.Db, owner.Id, "Plan", null, null, null)).Value!;
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var line = new JsonObject
        {
            ["o"] = "add",
            ["i"] = new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString(), ["k"] = "line", ["x"] = 0, ["y"] = 0, ["w"] = 5, ["h"] = 5,
                ["d"] = new JsonObject { ["a"] = new JsonObject { ["id"] = a.ToString() }, ["b"] = new JsonObject { ["id"] = b.ToString(), ["x"] = 1, ["y"] = 2 } },
            },
        };
        await BoardItems.ApplyAsync(t.Db, Actor.Of(owner.Id), board.Id, [Add(a), Add(b), line]);

        var copy = (await BoardService.DuplicateAsync(t.Db, owner.Id, board.Id, "copy")).Value!;
        var items = (await BoardItems.LoadAsync(t.Db, Actor.Of(owner.Id), copy.Id))!.Items;
        Assert.Equal("Plan (copy)", copy.Name);
        Assert.Equal(3, items.Count);
        var copiedIds = items.Where(i => i.K != "line").Select(i => i.Id).ToHashSet();
        Assert.DoesNotContain(a, copiedIds);
        var copiedLine = items.Single(i => i.K == "line");
        Assert.Contains(Guid.Parse(copiedLine.D["a"]!["id"]!.GetValue<string>()), copiedIds);
    }

    [Fact]
    public void Validation_accepts_what_the_app_draws_and_nothing_else()
    {
        Assert.Null(BoardItems.Validate("sticky", new JsonObject { ["fill"] = "#fff2a8", ["text"] = "x" }));
        Assert.Null(BoardItems.Validate("rect", new JsonObject { ["fill"] = "none", ["stroke"] = "#1e1e1e" }));
        Assert.NotNull(BoardItems.Validate("rect", new JsonObject { ["fill"] = "javascript:1" }));
        Assert.Null(BoardItems.Validate("image", new JsonObject { ["src"] = "data:image/png;base64,iVBORw0KGgo=" }));
        Assert.NotNull(BoardItems.Validate("image", new JsonObject { ["src"] = "data:image/svg+xml;base64,AAAA" }));
        Assert.NotNull(BoardItems.Validate("sticky", new JsonObject { ["text"] = new string('x', BoardItems.MaxDataBytes + 1) }));
    }

    [Fact]
    public void References_of_connectors_point_at_the_copies()
    {
        var a = Guid.NewGuid();
        var copy = Guid.NewGuid();
        var data = $$$"""{"a":{"id":"{{{a}}}","x":1,"y":2},"b":{"id":"{{{Guid.NewGuid()}}}","x":3,"y":4}}""";
        var mapped = JsonNode.Parse(BoardItems.RemapReferences(data, new Dictionary<Guid, Guid> { [a] = copy }))!;
        Assert.Equal(copy.ToString(), mapped["a"]!["id"]!.GetValue<string>());
        Assert.Null(mapped["b"]!["id"]);          // not copied: a loose end
        Assert.Equal(4, mapped["b"]!["y"]!.GetValue<int>());
    }
}
