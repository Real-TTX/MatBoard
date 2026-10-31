namespace MatBoard.Data;

/// <summary>What every record has: an Id (BIGINT) and who created and changed it, and when (the columns are filled by <see cref="AppDbContext"/>).</summary>
public abstract class Entity
{
    public long Id { get; set; }

    public DateTime CreateDate { get; set; }

    public long? CreateUserId { get; set; }

    public DateTime UpdateDate { get; set; }

    public long? UpdateUserId { get; set; }
}

/// <summary>A record that supports soft delete: 0 = deleted, 1 = created, 2 = updated. A deleted record is hidden by a query filter.</summary>
public abstract class SoftEntity : Entity
{
    public const short Deleted = 0;
    public const short Created = 1;
    public const short Updated = 2;

    public short UpdateState { get; set; } = Created;
}

public enum UserRole
{
    Admin = 1,
    User = 2,
}

/// <summary>What a person may do on a board they do not own. The owner (and an administrator of the installation, for housekeeping) may do everything.</summary>
public enum BoardRole
{
    /// <summary>No access.</summary>
    None = 0,

    /// <summary>May look at the board (and follow the others live).</summary>
    Viewer = 1,

    /// <summary>May change the content of the board.</summary>
    Editor = 2,

    /// <summary>May also change the name, the members and the link, and delete the board.</summary>
    Owner = 3,
}

/// <summary>What a link to a board allows for anybody who has it.</summary>
public enum LinkMode
{
    Off = 0,
    View = 1,
    Edit = 2,
}

public sealed class User : SoftEntity
{
    /// <summary>The address to sign in with; unique, stored in lower case.</summary>
    public string Email { get; set; } = string.Empty;

    public string DisplayName { get; set; } = string.Empty;

    public string PasswordHash { get; set; } = string.Empty;

    public UserRole Role { get; set; } = UserRole.User;

    public bool IsActive { get; set; } = true;

    /// <summary>The IANA time zone dates are shown in.</summary>
    public string TimeZone { get; set; } = "Europe/Berlin";

    /// <summary>The language of the interface: en or de; empty = the language of the browser.</summary>
    public string Language { get; set; } = string.Empty;

    public int FailedLogins { get; set; }

    public DateTime? LockoutUntil { get; set; }

    public DateTime? LastLoginDate { get; set; }

    /// <summary>system, light or dark.</summary>
    public string Theme { get; set; } = "system";

    /// <summary>standard, paper, contrast or oled.</summary>
    public string Scheme { get; set; } = "standard";

    /// <summary>The colour of the cursor and the name tag the others see on a board (#rrggbb); empty = chosen from the name.</summary>
    public string? CursorColor { get; set; }

    /// <summary>Mail about boards that are shared with the person (only when the installation can send mail).</summary>
    public bool MailOnShare { get; set; } = true;

    /// <summary>The person of MatIdentity (the claim <c>sub</c>) this account is linked with; null = a local account only.</summary>
    public string? ExternalSubject { get; set; }
}

/// <summary>A signed-in browser. The cookie carries the <see cref="Token"/>; the session lives in the database.</summary>
public sealed class UserSession : Entity
{
    public Guid Token { get; set; } = Guid.NewGuid();

    public long UserId { get; set; }

    public User? User { get; set; }

    public DateTime LastSeenDate { get; set; }

    public DateTime ExpiresDate { get; set; }

    public bool IsRevoked { get; set; }

    public string? UserAgent { get; set; }

    public string? IpAddress { get; set; }

    /// <summary>The ID token of a sign-in through MatIdentity (for the sign-out there); null for a local sign-in. A secret: never exported.</summary>
    public string? IdentityToken { get; set; }

    /// <summary>The session of MatIdentity (the claim <c>sid</c>) this session started with: the back-channel logout ends it by this.</summary>
    public string? IdentitySessionId { get; set; }
}

/// <summary>A whiteboard.</summary>
public sealed class Board : SoftEntity
{
    public string Name { get; set; } = string.Empty;

    public string? Description { get; set; }

    public long OwnerId { get; set; }

    public User? Owner { get; set; }

    /// <summary>The accent of the card in the list (#rrggbb).</summary>
    public string Color { get; set; } = "#ffd02f";

    /// <summary>The paper of the canvas: dots, grid, lines or none.</summary>
    public string Background { get; set; } = "dots";

    /// <summary>The secret of the link (<c>/b/&lt;token&gt;</c>); changing it ends every link that was given out.</summary>
    public Guid ShareToken { get; set; } = Guid.NewGuid();

    public LinkMode LinkMode { get; set; } = LinkMode.Off;

    /// <summary>Counts every change of the content: a client that holds an older number knows its copy is old (offline cache, reconnect).</summary>
    public long Revision { get; set; }

    public ICollection<BoardMember> Members { get; set; } = [];
}

/// <summary>A person a board is shared with (the owner is not a member, they are <see cref="Board.OwnerId"/>).</summary>
public sealed class BoardMember : Entity
{
    public long BoardId { get; set; }

    public Board? Board { get; set; }

    public long UserId { get; set; }

    public User? User { get; set; }

    public BoardRole Role { get; set; } = BoardRole.Editor;
}

/// <summary>
/// One thing on a board: a sticky note, a text, a shape, a line (connector), a pen stroke, a frame or an image. The columns hold what every kind has (where it is, how big,
/// in which order); <see cref="Data"/> holds the rest as JSON (text, colours, the points of a stroke, the ends of a connector). <see cref="Uid"/> is the id a browser
/// makes up when it creates the item, so the others can refer to it before the server answers.
/// </summary>
public sealed class BoardItem : Entity
{
    public long BoardId { get; set; }

    public Board? Board { get; set; }

    public Guid Uid { get; set; }

    /// <summary>sticky, text, rect, ellipse, diamond, triangle, line, pen, frame, image.</summary>
    public string Kind { get; set; } = string.Empty;

    public double X { get; set; }

    public double Y { get; set; }

    public double Width { get; set; }

    public double Height { get; set; }

    public double Rotation { get; set; }

    /// <summary>The order from back to front.</summary>
    public int Z { get; set; }

    public string Data { get; set; } = "{}";
}

/// <summary>The few settings of the whole installation (one row, Id 1).</summary>
public sealed class SystemSetting : Entity
{
    /// <summary>Whether anyone may create an account. Closed until an administrator opens it (Administration → System): the first account of an installation can always
    /// sign up (it becomes the administrator), after it the administrators create the accounts.</summary>
    public bool RegistrationOpen { get; set; }

    /// <summary>The address the app is reached at from outside (for the links in mails); empty = the address of the request.</summary>
    public string? PublicUrl { get; set; }
}
