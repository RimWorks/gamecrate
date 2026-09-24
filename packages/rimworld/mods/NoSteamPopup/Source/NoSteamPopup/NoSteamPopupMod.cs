using System.Reflection;
using Verse;
using Verse.Steam;

namespace NoSteamPopup;

public class NoSteamPopupMod : Mod
{
    public NoSteamPopupMod(ModContentPack content) : base(content)
    {
        var field = typeof(SteamManager).GetField("initializedInt", BindingFlags.Static | BindingFlags.NonPublic);
        if (field is null || field.FieldType != typeof(bool))
        {
            Log.Warning("[NoSteamPopup] SteamManager.initializedInt is gone; the Steam dialog will still appear.");
            return;
        }

        field.SetValue(null, true);
    }
}
