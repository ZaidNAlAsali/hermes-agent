#Requires AutoHotkey v2.0
#SingleInstance Force

logPath := A_Args.Length >= 1 ? A_Args[1] : "ahk.log"

ClickWithMarker(x, y, button := "Left") {
    ToolTip(Format("Clicking at {1}, {2}", x, y))

    ; Draw marker
    size := 20

    g := Gui("-Caption +AlwaysOnTop +ToolWindow")
    g.BackColor := "Red"

    g.Show(Format(
        "x{} y{} w{} h{} NoActivate"
        , x - size//2
        , y - size//2
        , size
        , size
    ))

    hRegion := DllCall(
        "CreateEllipticRgn"
        , "Int", 0
        , "Int", 0
        , "Int", size
        , "Int", size
        , "Ptr"
    )

    DllCall("SetWindowRgn", "Ptr", g.Hwnd, "Ptr", hRegion, "Int", true)

    ; Remove marker after 500ms
    SetTimer(() => g.Destroy(), -500)

    ; Perform click
    Click(x, y, button)
}



ToolTip("Waiting for the installer window to appear...")
winTitle := "Hermes"
try {
    WinWait(winTitle, , 30)
} catch {
    FileAppend("ERROR: Hermes installer window did not appear within 30s`n", logPath)
    ExitApp(1)
}
WinGetPos(&x, &y, &w, &h, winTitle)
FileAppend(Format("Window found at x={1} y={2} w={3} h={4}`n", x, y, w, h), logPath)
ToolTip(Format(""Installer window appeared at x={1} y={2} w={3} h={4}. Sleeping for a few seconds.....", x, y, w, h))

Sleep(3000)

; click install
clickX := (x + 448)
clickY := (y + 418)

ClickWithMarker(x, y)

Sleep(2000)
ToolTip("Done")

; done
ExitApp(0)