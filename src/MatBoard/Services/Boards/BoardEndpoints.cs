using System.Text.Json;
using System.Text.Json.Serialization;
using MatBoard.Data;

namespace MatBoard.Services.Boards;

/// <summary>
/// The two addresses the board page talks to: <c>GET /live/boards/{id}</c> (the content of a board as JSON) and <c>/live/boards/{id}/ws</c> (the WebSocket). Both are open
/// to the anonymous request on purpose, because a link gives guests access: what a request may see is decided by <see cref="BoardAccess"/> (the cookie of a person
/// and/or the secret of the link in <c>?t=</c>), and a board that is not theirs answers 404.
/// </summary>
public static class BoardEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static void MapBoardEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/live/boards/{id:long}", async (long id, HttpContext http, AppDbContext db, CurrentUser me) =>
        {
            var snapshot = await BoardItems.LoadAsync(db, ActorOf(http, me), id, http.RequestAborted);
            http.Response.Headers.CacheControl = "no-store";
            return snapshot is null ? Results.NotFound() : Results.Json(snapshot, Json);
        }).AllowAnonymous();

        app.Map("/live/boards/{id:long}/ws", async (long id, HttpContext http, AppDbContext db, CurrentUser me, BoardRooms rooms) =>
        {
            if (!http.WebSockets.IsWebSocketRequest)
            {
                return Results.BadRequest();
            }

            // a page of another site must not be able to open the socket with the cookie of a person (cross-site WebSocket hijacking)
            if (http.Request.Headers.Origin.ToString() is { Length: > 0 } origin
                && (!Uri.TryCreate(origin, UriKind.Absolute, out var from) || !string.Equals(from.Authority, http.Request.Host.Value, StringComparison.OrdinalIgnoreCase)))
            {
                return Results.StatusCode(StatusCodes.Status403Forbidden);
            }

            var actor = ActorOf(http, me);
            if (await BoardAccess.FindAsync(db, actor, id, ct: http.RequestAborted) is not { } access)
            {
                return Results.NotFound();
            }

            await rooms.ServeAsync(http, id, actor, access, http.Request.Query["n"].ToString());
            return Results.Empty;
        }).AllowAnonymous();
    }

    /// <summary>The person of the cookie (if any) and the secret of the link (if one is given).</summary>
    public static Actor ActorOf(HttpContext http, CurrentUser me)
    {
        var actor = new Actor(me.Id);
        return Guid.TryParse(http.Request.Query["t"], out var token) ? actor.WithLink(token) : actor;
    }
}
