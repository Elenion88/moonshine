"""
Minimal menu bar probe - no rumps, no launchd, nothing of ours.

Creates one NSStatusItem with an unmistakable label and reports what the system
says about it. Run this in a real GUI session (from Terminal) to separate two
very different explanations for a missing icon:

  * the label appears -> the environment is fine and our app has the bug
  * the label does not appear -> the menu bar has no room, or this process has
    no window server access, and no amount of fixing our app would help
"""

import objc
from AppKit import NSApplication, NSStatusBar, NSVariableStatusItemLength
from PyObjCTools import AppHelper

NSApplicationActivationPolicyAccessory = 1

app = NSApplication.sharedApplication()
app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)

bar = NSStatusBar.systemStatusBar()
item = bar.statusItemWithLength_(NSVariableStatusItemLength)

button = item.button()
if button is None:
    print("FAIL: statusItem.button() is None - no status item was created")
    raise SystemExit(1)

button.setTitle_("REMOTETEST")

print("--- menu bar probe ---")
print(f"  status item created : {item is not None}")
print(f"  button              : {button}")
print(f"  title set to        : {button.title()!r}")
print(f"  item visible        : {item.isVisible()}")
print(f"  button width        : {button.frame().size.width}")
print(f"  menu bar thickness  : {bar.thickness()}")
print()
print("Look at the menu bar now. You are looking for the text REMOTETEST.")
print("Press Ctrl-C in this window when you are done.")

AppHelper.runEventLoop()
