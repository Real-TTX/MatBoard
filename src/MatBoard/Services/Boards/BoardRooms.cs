using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MatBoard.Data;
using Microsoft.EntityFrameworkCore;

namespace MatBoard.Services.Boards;

/// <summary>
/// The live side of the boards: one WebSocket per open board per browser. A board is a room; what one browser changes is stored (<see cref="BoardItems.ApplyAsync"/>, which
/// checks the right of the person) and then sent to everybody else in the room, together with the cursors and who is there. The rooms live in memory of this one server:
/// the database is the truth, a browser that missed something (it was offline) loads the board again.
/// </summary>
public sealed class BoardRooms(IServiceScopeFactory scopes, ILogger<BoardRooms> logger)
{
    private const int MaxMessageBytes = 4_500_000;
    private static readonly IReadOnlyList<string> Palette = [.. BoardService.CursorColors.Select(c => c.Value)];

    private readonly ConcurrentDictionary<long, ConcurrentDictionary<int, Peer>> _rooms = new();
    private int _nextPeer;

    private sealed class Peer(int id, Actor actor, string name, string color, WebSocket socket, BoardRole role)
    {
        public int Id { get; } = id;

        public Actor Actor { get; } = actor;

        public string Name { get; } = name;

        public string Color { get; } = color;

        public WebSocket Socket { get; } = socket;

        public BoardRole Role { get; set; } = role;

        public SemaphoreSlim SendLock { get; } = new(1, 1);

        public DateTime WindowStart { get; set; } = DateTime.UtcNow;

        public int OpsInWindow { get; set; }
    }

    /// <summary>The number of people connected to a board (for the list and the tests).</summary>
    public int PeersOf(long boardId) => _rooms.TryGetValue(boardId, out var room) ? room.Count : 0;

    /// <summary>Takes a WebSocket of a person who may see the board and serves it until it closes.</summary>
    public async Task ServeAsync(HttpContext http, long boardId, Actor actor, BoardAccessInfo access, string? guestName)
    {
        using var socket = await http.WebSockets.AcceptWebSocketAsync();
        var (name, color) = await IdentityAsync(actor, guestName);
        var peer = new Peer(Interlocked.Increment(ref _nextPeer), actor, name, color, socket, access.Role);
        var room = _rooms.GetOrAdd(boardId, _ => new ConcurrentDictionary<int, Peer>());
        var others = room.Values.Select(p => PeerJson(p)).ToArray();

        room[peer.Id] = peer;
        await SendAsync(peer, new JsonObject
        {
            ["t"] = "hello",
            ["you"] = peer.Id,
            ["role"] = RoleName(peer.Role),
            ["rev"] = access.Board.Revision,
            ["peers"] = new JsonArray(others),
        });
        await BroadcastAsync(room, peer.Id, new JsonObject { ["t"] = "peer+", ["peer"] = PeerJson(peer) });

        try
        {
            await ReceiveLoopAsync(http, boardId, room, peer);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or IOException)
        {
            // the browser went away: nothing to report
        }
        finally
        {
            // an empty room stays (a few bytes): removing it would race with somebody who joins at the same moment
            room.TryRemove(peer.Id, out _);
            await BroadcastAsync(room, peer.Id, new JsonObject { ["t"] = "peer-", ["id"] = peer.Id });
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                }
                catch (WebSocketException)
                {
                    // already gone
                }
            }
        }
    }

    /// <summary>
    /// Asks again what everybody connected to a board may do (after the members or the link changed): somebody who may no longer see it is sent away, the others learn
    /// their new role.
    /// </summary>
    public async Task RevalidateAsync(long boardId)
    {
        if (!_rooms.TryGetValue(boardId, out var room))
        {
            return;
        }

        foreach (var peer in room.Values.ToList())
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var role = await BoardAccess.FindAsync(db, peer.Actor, boardId) is { } access ? access.Role : BoardRole.None;
            if (role == BoardRole.None)
            {
                await SendAsync(peer, new JsonObject { ["t"] = "gone" });
                try
                {
                    await peer.Socket.CloseAsync(WebSocketCloseStatus.PolicyViolation, "access ended", CancellationToken.None);
                }
                catch (WebSocketException)
                {
                    // already gone
                }
            }
            else if (role != peer.Role)
            {
                peer.Role = role;
                await SendAsync(peer, new JsonObject { ["t"] = "role", ["role"] = RoleName(role) });
            }
        }
    }

    /// <summary>Tells the people on a board that it was changed from outside the room (its name or paper in the settings).</summary>
    public Task NotifyAsync(long boardId, JsonObject message)
        => _rooms.TryGetValue(boardId, out var room) ? BroadcastAsync(room, -1, message) : Task.CompletedTask;

    private async Task ReceiveLoopAsync(HttpContext http, long boardId, ConcurrentDictionary<int, Peer> room, Peer peer)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (!http.RequestAborted.IsCancellationRequested && peer.Socket.State == WebSocketState.Open)
        {
            message.SetLength(0);
            WebSocketReceiveResult result;
            do
            {
                result = await peer.Socket.ReceiveAsync(buffer, http.RequestAborted);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return;
                }

                message.Write(buffer, 0, result.Count);
                if (message.Length > MaxMessageBytes)
                {
                    await peer.Socket.CloseAsync(WebSocketCloseStatus.MessageTooBig, "message too big", CancellationToken.None);
                    return;
                }
            }
            while (!result.EndOfMessage);

            if (result.MessageType != WebSocketMessageType.Text || TooFast(peer))
            {
                continue;
            }

            JsonObject? json;
            try
            {
                json = JsonNode.Parse(message.ToArray()) as JsonObject;
            }
            catch (JsonException)
            {
                continue;
            }

            if (json?["t"]?.GetValue<string>() is { } type)
            {
                await HandleAsync(boardId, room, peer, type, json);
            }
        }
    }

    private async Task HandleAsync(long boardId, ConcurrentDictionary<int, Peer> room, Peer peer, string type, JsonObject json)
    {
        switch (type)
        {
            case "ops" when json["ops"] is JsonArray ops:
                await ApplyAsync(boardId, room, peer, json["cid"]?.ToString(), [.. ops]);
                break;
            case "cur" when json["x"] is JsonValue x && json["y"] is JsonValue y && x.TryGetValue<double>(out var cx) && y.TryGetValue<double>(out var cy) && double.IsFinite(cx) && double.IsFinite(cy):
                await BroadcastAsync(room, peer.Id, new JsonObject { ["t"] = "cur", ["id"] = peer.Id, ["x"] = Math.Round(cx, 1), ["y"] = Math.Round(cy, 1) });
                break;
            // where somebody looks (for the people who follow them), and "come here" (everybody jumps to the view of an editor or the owner)
            case "view" or "summon" when ViewOf(json) is { } view:
                if (type == "summon" && peer.Role < BoardRole.Editor)
                {
                    break;
                }

                view["t"] = type;
                view["id"] = peer.Id;
                await BroadcastAsync(room, peer.Id, view);
                break;
            case "ping":
                await SendAsync(peer, new JsonObject { ["t"] = "pong" });
                break;
        }
    }

    private async Task ApplyAsync(long boardId, ConcurrentDictionary<int, Peer> room, Peer peer, string? cid, List<JsonNode?> ops)
    {
        ApplyResult result;
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            result = await BoardItems.ApplyAsync(db, peer.Actor, boardId, ops);
        }
        catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException or Npgsql.NpgsqlException)
        {
            logger.LogWarning(ex, "Changes to board {BoardId} could not be stored", boardId);
            await SendAsync(peer, new JsonObject { ["t"] = "err", ["code"] = "store", ["cid"] = cid });
            return;
        }

        if (!result.Allowed)
        {
            await SendAsync(peer, new JsonObject { ["t"] = "err", ["code"] = "forbidden", ["cid"] = cid });
            return;
        }

        await SendAsync(peer, new JsonObject
        {
            ["t"] = "ack",
            ["cid"] = cid,
            ["rev"] = result.Revision,
            ["rejected"] = new JsonArray(result.Rejected.Select(r => (JsonNode?)JsonValue.Create(r)).ToArray()),
        });
        if (result.Accepted.Count > 0)
        {
            await BroadcastAsync(room, peer.Id, new JsonObject
            {
                ["t"] = "ops",
                ["from"] = peer.Id,
                ["rev"] = result.Revision,
                ["ops"] = new JsonArray(result.Accepted.Select(o => (JsonNode?)o.DeepClone()).ToArray()),
            });
        }
    }

    /// <summary>A rectangle of the board (x, y, width, height), checked; or <c>null</c>.</summary>
    private static JsonObject? ViewOf(JsonObject json)
    {
        var view = new JsonObject();
        foreach (var key in new[] { "x", "y", "w", "h" })
        {
            if (json[key] is not JsonValue v || !v.TryGetValue<double>(out var value) || !double.IsFinite(value) || Math.Abs(value) > 1e7 || (key is "w" or "h" && value <= 0))
            {
                return null;
            }

            view[key] = Math.Round(value, 1);
        }

        return view;
    }

    /// <summary>More than 400 messages in ten seconds from one browser: the rest is dropped (a script gone wrong, or somebody who is not a person).</summary>
    private static bool TooFast(Peer peer)
    {
        var now = DateTime.UtcNow;
        if (now - peer.WindowStart > TimeSpan.FromSeconds(10))
        {
            peer.WindowStart = now;
            peer.OpsInWindow = 0;
        }

        return ++peer.OpsInWindow > 400;
    }

    private async Task<(string Name, string Color)> IdentityAsync(Actor actor, string? guestName)
    {
        if (actor.UserId is { } userId)
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var user = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => new { u.DisplayName, u.CursorColor }).FirstOrDefaultAsync();
            if (user is not null)
            {
                return (user.DisplayName, Ui.IsColour(user.CursorColor) ? user.CursorColor! : ColorOf(user.DisplayName + userId));
            }
        }

        var name = string.IsNullOrWhiteSpace(guestName) ? "Guest" : new string([.. guestName.Trim().Where(c => !char.IsControl(c)).Take(30)]);
        return (name, ColorOf(name + Guid.NewGuid()));
    }

    private static string ColorOf(string seed)
    {
        var hash = 17;
        foreach (var c in seed)
        {
            hash = unchecked(hash * 31 + c);
        }

        return Palette[Math.Abs(hash % Palette.Count)];
    }

    private static JsonObject PeerJson(Peer p) => new() { ["id"] = p.Id, ["name"] = p.Name, ["color"] = p.Color, ["role"] = RoleName(p.Role) };

    private static string RoleName(BoardRole role) => role.ToString().ToLowerInvariant();

    private static async Task BroadcastAsync(ConcurrentDictionary<int, Peer> room, int exceptPeer, JsonObject message)
    {
        var text = message.ToJsonString();
        var sends = room.Values.Where(p => p.Id != exceptPeer).Select(p => SendTextAsync(p, text));
        await Task.WhenAll(sends);
    }

    private static Task SendAsync(Peer peer, JsonObject message) => SendTextAsync(peer, message.ToJsonString());

    private static async Task SendTextAsync(Peer peer, string text)
    {
        if (peer.Socket.State != WebSocketState.Open)
        {
            return;
        }

        var bytes = Encoding.UTF8.GetBytes(text);
        await peer.SendLock.WaitAsync();
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            await peer.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, timeout.Token);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            // a browser that cannot be reached is removed by its own receive loop
        }
        finally
        {
            peer.SendLock.Release();
        }
    }
}
