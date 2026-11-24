# Continuous host samples on the main mini

Run the sampler once with `python3 -B scripts/res/host-sampler.py --once`. For a per-user LaunchAgent, run these commands from the installed repository. The agent samples every 60 seconds and writes under the shared resource directory. See [the sample schema](references/host-samples.md).

```sh
plist="$HOME/Library/LaunchAgents/com.user.host-sampler.plist"
python3 - "$plist" "$PWD/scripts/res/host-sampler.py" <<'PY'
import plistlib, sys
with open(sys.argv[1], "xb") as stream:
    plistlib.dump(dict(Label="com.user.host-sampler", RunAtLoad=True, KeepAlive=True,
                       ProgramArguments=[sys.executable,"-B",sys.argv[2],"--loop","60"]), stream)
PY
launchctl bootstrap "gui/$(id -u)" "$plist"
```

Uninstall with `launchctl bootout "gui/$(id -u)/com.user.host-sampler" && rm "$HOME/Library/LaunchAgents/com.user.host-sampler.plist"`.
