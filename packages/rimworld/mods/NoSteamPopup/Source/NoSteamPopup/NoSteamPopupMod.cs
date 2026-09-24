using Concord;
using Verse;
using Verse.Steam;

namespace NoSteamPopup;

public class NoSteamPopupMod : Mod
{
    public NoSteamPopupMod(ModContentPack content) : base(content)
    {
        Patcher.Apply(typeof(NoSteamPopupMod).Assembly);
    }
}

[Patch]
internal abstract class UIRoot_Entry_Patch : UIRoot_Entry
{
    [Inject(nameof(UIRoot_Entry.Init), typeof(SteamManager), nameof(SteamManager.Initialized), At.Around)]
    private bool AlwaysInitialized(Operation<bool> read) => true;
}
