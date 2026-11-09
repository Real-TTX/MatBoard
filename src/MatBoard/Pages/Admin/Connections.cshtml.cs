namespace MatBoard.Pages.Admin;

/// <summary>
/// The connections of MatBoard to other apps (the Mat app model): the Connections area of every app (<c>&lt;mat-connections /&gt;</c> of MatPlatform: what MatBoard
/// uses (the sign-in through MatIdentity, the mail through MatSMTP), how each was set, what it adds to a home screen). Mattiverse makes the bindings by itself;
/// without it the variables of the compose file set them. Administrators only (the folder <c>/Admin</c> and <c>MatPlatformOptions.ConnectionsAccess</c>).
/// </summary>
public sealed class ConnectionsModel : AppPageModel
{
    public void OnGet()
    {
    }
}
