using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MatBoard.Data;
using Microsoft.EntityFrameworkCore;

namespace MatBoard.Services.Boards;

/// <summary>An item as it travels between the browser and the server (short names: a board can hold thousands of them).</summary>
public sealed record ItemDto(Guid Id, string K, double X, double Y, double W, double H, double R, int Z, JsonObject D);

/// <summary>What a browser gets when it opens a board.</summary>
public sealed record BoardSnapshot(long Id, string Name, string Background, BoardRole Role, long Revision, IReadOnlyList<ItemDto> Items);

/// <summary>
/// What became of a batch of changes: <see cref="Accepted"/> are the changes as they were stored (the others get exactly these), <see cref="Rejected"/> the reasons for the
/// ones that were not (they are dropped, the rest of the batch is kept).
/// </summary>
public sealed record ApplyResult(bool Allowed, IReadOnlyList<JsonObject> Accepted, IReadOnlyList<string> Rejected, long Revision);

/// <summary>
/// The content of a board: reading it, and changing it by a batch of operations (<c>add</c>, <c>upd</c>, <c>del</c>) that a browser sends. The server never trusts a browser:
/// the right of the person is checked for every batch, every number and colour is validated and the sizes are limited. Two people changing the same thing at once: the later
/// change wins, field by field (<c>d</c> is merged key by key, so a new colour and a new text from two people both survive).
/// </summary>
public static partial class BoardItems
{
    public const int MaxItemsPerBoard = 5000;
    public const int MaxOpsPerBatch = 500;
    public const int MaxDataBytes = 120_000;
    public const int MaxImageBytes = 3_000_000;

    public static readonly IReadOnlySet<string> Kinds = new HashSet<string>(["sticky", "text", "rect", "ellipse", "diamond", "triangle", "line", "pen", "frame", "image"]);

    private static readonly string[] ColourKeys = ["fill", "stroke", "color", "bg"];
    private static readonly string[] ImagePrefixes = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,", "data:image/gif;base64,"];
    private static readonly ConcurrentDictionary<long, SemaphoreSlim> Locks = new();

    [GeneratedRegex(@"^(#[0-9a-fA-F]{3,8}|none|transparent)$")]
    private static partial Regex ColourRegex();

    /// <summary>The content of a board for somebody who may see it, or <c>null</c>.</summary>
    public static async Task<BoardSnapshot?> LoadAsync(AppDbContext db, Actor actor, long boardId, CancellationToken ct = default)
    {
        if (await BoardAccess.FindAsync(db, actor, boardId, ct: ct) is not { } access)
        {
            return null;
        }

        var rows = await db.BoardItems.AsNoTracking().Where(i => i.BoardId == boardId).OrderBy(i => i.Z).ThenBy(i => i.Id).ToListAsync(ct);
        return new BoardSnapshot(access.Board.Id, access.Board.Name, access.Board.Background, access.Role, access.Board.Revision, rows.Select(ToDto).ToList());
    }

    /// <summary>Applies a batch of changes made by <paramref name="actor"/>. Only an editor (or the owner) may; otherwise <see cref="ApplyResult.Allowed"/> is false.</summary>
    public static async Task<ApplyResult> ApplyAsync(AppDbContext db, Actor actor, long boardId, IReadOnlyList<JsonNode?> ops, CancellationToken ct = default)
    {
        var gate = Locks.GetOrAdd(boardId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            if (await BoardAccess.FindAsync(db, actor, boardId, BoardRole.Editor, ct: ct) is null)
            {
                return new ApplyResult(false, [], [], 0);
            }

            return await ApplyLockedAsync(db, actor, boardId, ops, ct);
        }
        finally
        {
            gate.Release();
        }
    }

    private static async Task<ApplyResult> ApplyLockedAsync(AppDbContext db, Actor actor, long boardId, IReadOnlyList<JsonNode?> ops, CancellationToken ct)
    {
        var accepted = new List<JsonObject>();
        var rejected = new List<string>();
        var parsed = ops.Take(MaxOpsPerBatch).ToList();
        if (ops.Count > MaxOpsPerBatch)
        {
            rejected.Add("too many changes at once");
        }

        var uids = parsed.Select(OpUid).Where(u => u is not null).Select(u => u!.Value).Distinct().ToList();
        var items = await db.BoardItems.Where(i => i.BoardId == boardId && uids.Contains(i.Uid)).ToDictionaryAsync(i => i.Uid, ct);
        var count = await db.BoardItems.CountAsync(i => i.BoardId == boardId, ct);

        foreach (var node in parsed)
        {
            if (node is not JsonObject op || op["o"]?.GetValue<string>() is not { } kind)
            {
                rejected.Add("not a change");
                continue;
            }

            string? error;
            JsonObject? echo;
            switch (kind)
            {
                case "add":
                    (echo, error) = Add(db, boardId, actor, op, items, ref count);
                    break;
                case "upd":
                    (echo, error) = Update(op, items);
                    break;
                case "del":
                    (echo, error) = Delete(db, op, items, ref count);
                    break;
                default:
                    (echo, error) = (null, "unknown change");
                    break;
            }

            if (error is not null)
            {
                rejected.Add(error);
            }
            else if (echo is not null)
            {
                accepted.Add(echo);
            }
        }

        if (accepted.Count == 0)
        {
            return new ApplyResult(true, accepted, rejected, await db.Boards.Where(b => b.Id == boardId).Select(b => b.Revision).FirstOrDefaultAsync(ct));
        }

        await db.SaveChangesAsync(ct);
        var now = DateTime.UtcNow;
        await db.Boards.Where(b => b.Id == boardId).ExecuteUpdateAsync(
            s => s.SetProperty(b => b.Revision, b => b.Revision + 1).SetProperty(b => b.UpdateDate, now).SetProperty(b => b.UpdateUserId, actor.UserId), ct);
        var revision = await db.Boards.Where(b => b.Id == boardId).Select(b => b.Revision).FirstAsync(ct);
        return new ApplyResult(true, accepted, rejected, revision);
    }

    private static (JsonObject? Echo, string? Error) Add(AppDbContext db, long boardId, Actor actor, JsonObject op, Dictionary<Guid, BoardItem> items, ref int count)
    {
        if (op["i"] is not JsonObject wire || !TryGuid(wire["id"], out var uid))
        {
            return (null, "add without an item");
        }

        var kind = wire["k"]?.GetValue<string>() ?? string.Empty;
        if (!Kinds.Contains(kind))
        {
            return (null, "unknown kind of item");
        }

        var existing = items.GetValueOrDefault(uid);
        if (existing is null && count >= MaxItemsPerBoard)
        {
            return (null, "the board is full");
        }

        if (!Geometry(wire, out var x, out var y, out var w, out var h, out var r, out var z) || wire["d"] is not JsonObject data || Validate(kind, data) is { } problem)
        {
            return (null, "invalid item");
        }

        if (existing is null)
        {
            existing = new BoardItem { BoardId = boardId, Uid = uid, CreateUserId = actor.UserId };
            db.BoardItems.Add(existing);
            items[uid] = existing;
            count++;
        }

        existing.Kind = kind;
        existing.X = x;
        existing.Y = y;
        existing.Width = w;
        existing.Height = h;
        existing.Rotation = r;
        existing.Z = z;
        existing.Data = data.ToJsonString();
        return (new JsonObject { ["o"] = "add", ["i"] = ToWire(existing) }, null);
    }

    private static (JsonObject? Echo, string? Error) Update(JsonObject op, Dictionary<Guid, BoardItem> items)
    {
        if (!TryGuid(op["id"], out var uid))
        {
            return (null, "upd without an id");
        }

        if (!items.TryGetValue(uid, out var item))
        {
            // somebody deleted it meanwhile: nothing to change, not an error
            return (null, null);
        }

        var echo = new JsonObject { ["o"] = "upd", ["id"] = uid.ToString() };
        foreach (var key in new[] { "x", "y", "w", "h", "r" })
        {
            if (op[key] is null)
            {
                continue;
            }

            if (!Number(op[key], 1e7, out var value) || (key is "w" or "h" && value < 0))
            {
                return (null, $"invalid {key}");
            }

            switch (key)
            {
                case "x": item.X = value; break;
                case "y": item.Y = value; break;
                case "w": item.Width = value; break;
                case "h": item.Height = value; break;
                default: item.Rotation = value; break;
            }

            echo[key] = value;
        }

        if (op["z"] is { } zNode)
        {
            if (!Number(zNode, 2e9, out var zValue))
            {
                return (null, "invalid z");
            }

            item.Z = (int)zValue;
            echo["z"] = item.Z;
        }

        if (op["d"] is JsonObject patch)
        {
            var merged = ParseObject(item.Data);
            foreach (var (key, value) in patch)
            {
                if (value is null)
                {
                    merged.Remove(key);
                }
                else
                {
                    merged[key] = value.DeepClone();
                }
            }

            if (Validate(item.Kind, merged) is not null)
            {
                return (null, "invalid data");
            }

            item.Data = merged.ToJsonString();
            echo["d"] = patch.DeepClone();
        }

        return (echo, null);
    }

    private static (JsonObject? Echo, string? Error) Delete(AppDbContext db, JsonObject op, Dictionary<Guid, BoardItem> items, ref int count)
    {
        if (!TryGuid(op["id"], out var uid))
        {
            return (null, "del without an id");
        }

        if (items.Remove(uid, out var item))
        {
            if (db.Entry(item).State == EntityState.Added)
            {
                db.Entry(item).State = EntityState.Detached;
            }
            else
            {
                db.BoardItems.Remove(item);
            }

            count--;
        }

        return (new JsonObject { ["o"] = "del", ["id"] = uid.ToString() }, null);
    }

    /// <summary>
    /// The data of an item, checked: a size limit, colours that are colours, a picture that is a picture (a data address of a bitmap: never an SVG, which can carry a script).
    /// Answers the problem, or <c>null</c> when it is fine.
    /// </summary>
    public static string? Validate(string kind, JsonObject data)
    {
        if (data.Count > 40)
        {
            return "too many properties";
        }

        foreach (var key in ColourKeys)
        {
            if (data[key] is { } colour && (colour is not JsonValue || !colour.AsValue().TryGetValue<string>(out var text) || !ColourRegex().IsMatch(text)))
            {
                return $"{key} is not a colour";
            }
        }

        if (kind == "image")
        {
            if (data["src"] is not JsonValue src || !src.TryGetValue<string>(out var address) || !ImagePrefixes.Any(p => address.StartsWith(p, StringComparison.Ordinal)))
            {
                return "not a bitmap picture";
            }

            return address.Length > MaxImageBytes ? "picture too big" : null;
        }

        return data.ToJsonString().Length > MaxDataBytes ? "item too big" : null;
    }

    /// <summary>The data of a copied item with its references (the ends of a connector) pointing at the copies; an end whose item was not copied becomes a loose end.</summary>
    public static string RemapReferences(string dataJson, IReadOnlyDictionary<Guid, Guid> map)
    {
        var data = ParseObject(dataJson);
        foreach (var end in new[] { "a", "b" })
        {
            if (data[end] is not JsonObject target || target["id"]?.GetValue<string>() is not { } id)
            {
                continue;
            }

            if (Guid.TryParse(id, out var old) && map.TryGetValue(old, out var copy))
            {
                target["id"] = copy.ToString();
            }
            else
            {
                target.Remove("id");
            }
        }

        return data.ToJsonString();
    }

    public static ItemDto ToDto(BoardItem i) => new(i.Uid, i.Kind, i.X, i.Y, i.Width, i.Height, i.Rotation, i.Z, ParseObject(i.Data));

    private static JsonObject ToWire(BoardItem i) => new()
    {
        ["id"] = i.Uid.ToString(),
        ["k"] = i.Kind,
        ["x"] = i.X,
        ["y"] = i.Y,
        ["w"] = i.Width,
        ["h"] = i.Height,
        ["r"] = i.Rotation,
        ["z"] = i.Z,
        ["d"] = ParseObject(i.Data),
    };

    private static JsonObject ParseObject(string json)
    {
        try
        {
            return JsonNode.Parse(json) as JsonObject ?? new JsonObject();
        }
        catch (JsonException)
        {
            return new JsonObject();
        }
    }

    private static Guid? OpUid(JsonNode? op)
    {
        if (op is not JsonObject o)
        {
            return null;
        }

        var node = o["o"]?.GetValue<string>() == "add" ? (o["i"] as JsonObject)?["id"] : o["id"];
        return TryGuid(node, out var guid) ? guid : null;
    }

    private static bool TryGuid(JsonNode? node, out Guid guid)
    {
        guid = default;
        return node is JsonValue v && v.TryGetValue<string>(out var text) && Guid.TryParse(text, out guid);
    }

    private static bool Geometry(JsonObject wire, out double x, out double y, out double w, out double h, out double r, out int z)
    {
        x = y = w = h = r = 0;
        z = 0;
        if (!Number(wire["x"], 1e7, out x) || !Number(wire["y"], 1e7, out y) || !Number(wire["w"], 1e7, out w) || !Number(wire["h"], 1e7, out h) || w < 0 || h < 0)
        {
            return false;
        }

        if (wire["r"] is { } rotation && !Number(rotation, 1e5, out r))
        {
            return false;
        }

        if (wire["z"] is { } zNode)
        {
            if (!Number(zNode, 2e9, out var zValue))
            {
                return false;
            }

            z = (int)zValue;
        }

        return true;
    }

    private static bool Number(JsonNode? node, double limit, out double value)
    {
        value = 0;
        if (node is not JsonValue v || v.GetValueKind() != JsonValueKind.Number || !double.TryParse(v.ToJsonString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out value))
        {
            return false;
        }

        return double.IsFinite(value) && Math.Abs(value) <= limit;
    }

}
