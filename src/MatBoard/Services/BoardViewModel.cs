using MatBoard.Data;

namespace MatBoard.Services;

/// <summary>What the page of a board needs: who is looking and what they may do. <c>LinkToken</c> is the secret of the link for a guest (and empty for a person who is signed in).</summary>
public sealed record BoardViewModel(long Id, string Name, BoardRole Role, string Background, string LinkToken, bool Guest, string Person, string Zone);
