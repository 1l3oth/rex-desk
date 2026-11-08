# Computer control: everything Jev can do

Rex Desk can control the computer it runs on. You ask in Khmer, English, or Korean, by voice or by typing, on the **Computer control** page (the microphone in the left bar, or **Alt+J** anywhere).
Jev chooses the action, a small model fills in values such as an app name or a volume level, and Rex Desk does it on this computer.
Agents can use the same actions through the `desk_computer_actions`, `desk_computer`, and `desk_computer_screenshot` tools once you allow it in **Settings → Computer control**.

**Asks first** actions wait for your yes, unless you turn that off in Settings.

Generated from `src/computer.js`. ✅ = works, — = not on that system.

## Apps & windows

| Action | What it does | Windows | macOS |
|---|---|---|---|
| **Open an app** <br><code>open_app</code> | Open or start an installed application by its name, such as Chrome, Word, Calculator, Spotify, or File Explorer | ✅ Start menu apps (Get-StartApps), then any program name | ✅ `open -a` on apps in /Applications |
| **Close an app** (asks first) <br><code>quit_app</code> | Close or quit an open application by its name | ✅ | ✅ |
| **List installed apps** <br><code>list_apps</code> | List the applications installed on this computer | ✅ | ✅ |
| **List open windows** <br><code>list_windows</code> | List the windows and applications that are open right now | ✅ | ✅ |
| **Switch to a window** <br><code>focus_window</code> | Bring an open application or window to the front so it can be used | ✅ | ✅ |
| **Show the desktop** <br><code>show_desktop</code> | Minimize every window and show the desktop | ✅ | ✅ |
| **Open a web page** <br><code>open_url</code> | Open a website or web address in the browser | ✅ | ✅ |
| **Search the web** <br><code>web_search</code> | Search Google for something in the browser | ✅ | ✅ |
| **Open a folder or file** <br><code>open_folder</code> | Open a folder such as Downloads, Documents, or Desktop, or a file, in File Explorer or Finder | ✅ | ✅ |
| **Open Settings** <br><code>open_settings</code> | Open the system Settings app, or one page of it such as display, sound, Bluetooth, Wi-Fi, battery, privacy, or updates | ✅ | ✅ |

## Sound & media

| Action | What it does | Windows | macOS |
|---|---|---|---|
| **Set the volume** <br><code>volume_set</code> | Set the speaker volume to a level from 0 to 100 percent | ✅ | ✅ |
| **Turn the volume up** <br><code>volume_up</code> | Make the sound louder | ✅ | ✅ |
| **Turn the volume down** <br><code>volume_down</code> | Make the sound quieter | ✅ | ✅ |
| **Mute the sound** <br><code>mute</code> | Turn the sound off, mute the speakers | ✅ | ✅ |
| **Unmute the sound** <br><code>unmute</code> | Turn the sound back on, unmute the speakers | ✅ | ✅ |
| **Check the volume** <br><code>volume_status</code> | Say how loud the sound is and whether it is muted | ✅ | ✅ |
| **Mute the microphone** <br><code>microphone_mute</code> | Turn the microphone off, mute it | ✅ Mutes the default microphone | ✅ Sets input volume to 0 |
| **Unmute the microphone** <br><code>microphone_unmute</code> | Turn the microphone back on | ✅ | ✅ |
| **Play, pause, or skip media** <br><code>media</code> | Play or pause music or video, or skip to the next or previous track | ✅ Media keys | ✅ Spotify if open, else Music |
| **Say something aloud** <br><code>speak</code> | Read a sentence out loud with the computer voice | ✅ | ✅ |

## Screen

| Action | What it does | Windows | macOS |
|---|---|---|---|
| **Set screen brightness** <br><code>brightness_set</code> | Make the screen brighter or dimmer, set brightness from 0 to 100 percent | ✅ Built-in laptop screen only | ✅ Presses the brightness keys |
| **Dark or light mode** <br><code>dark_mode</code> | Switch the computer to dark mode or to light mode | ✅ | ✅ |
| **Turn the screen off** <br><code>screen_off</code> | Turn off the display without sleeping; moving the mouse turns it back on | ✅ | ✅ |
| **Take a screenshot** <br><code>screenshot</code> | Take a picture of the whole screen | ✅ | ✅ |

## Mouse & keyboard

| Action | What it does | Windows | macOS |
|---|---|---|---|
| **Read the screen** <br><code>screen_items</code> | List the buttons, links, menus, tabs, and fields in the window in front, to find something to click | ✅ Windows UI Automation | ✅ Accessibility (System Events); needs Accessibility permission |
| **Click a button or link by name** <br><code>click_item</code> | Click, press, select, or tick a button, link, menu, tab, checkbox, or field on screen by the words written on it | ✅ Invokes the button, link, tab, or checkbox directly | ✅ Clicks its centre; needs Accessibility permission |
| **Click at a position** <br><code>click</code> | Click the mouse at a screen position | ✅ | ✅ |
| **Move the mouse** <br><code>move_mouse</code> | Move the mouse pointer to a screen position | ✅ | ✅ |
| **Scroll** <br><code>scroll</code> | Scroll the page or window up or down | ✅ | ✅ |
| **Drag** <br><code>drag</code> | Drag with the mouse from one screen position to another | ✅ | ✅ |
| **Type text** <br><code>type_text</code> | Type words or sentences with the keyboard into the box that has focus, in any language | ✅ Unicode typing: Khmer, Korean, any language | ✅ Pastes through the clipboard so Khmer and Korean work |
| **Press keys** <br><code>press_keys</code> | Press a key or a keyboard shortcut, such as enter, escape, ctrl+c, ctrl+s, or alt+tab | ✅ | ✅ |
| **Read the clipboard** <br><code>clipboard_read</code> | Read the text that was copied to the clipboard | ✅ | ✅ |
| **Copy text** <br><code>clipboard_write</code> | Put text on the clipboard so it can be pasted | ✅ | ✅ |

## Devices & privacy

| Action | What it does | Windows | macOS |
|---|---|---|---|
| **Camera on or off** <br><code>camera</code> | Turn the camera on or off: allow or block apps from using the webcam | ✅ Blocks or allows every app (Windows privacy switch) | ✅ Opens Privacy → Camera; macOS has no switch |
| **Allow or block the microphone** <br><code>microphone_access</code> | Allow or block apps from using the microphone at all | ✅ Blocks or allows every app (Windows privacy switch) | ✅ Opens Privacy → Microphone |
| **Wi-Fi on or off** <br><code>wifi</code> | Turn Wi-Fi on or off | ✅ | ✅ |
| **Bluetooth on or off** <br><code>bluetooth</code> | Turn Bluetooth on or off | ✅ Windows radio switch | ✅ `blueutil` if installed, else opens Bluetooth settings |

## Battery & power

| Action | What it does | Windows | macOS |
|---|---|---|---|
| **Check the battery** <br><code>battery_status</code> | Say how much battery is left and whether the computer is charging | ✅ | ✅ |
| **Battery saver on or off** <br><code>battery_saver</code> | Turn battery saver, energy saver, or low power mode on or off to make the battery last longer | ✅ Battery-saver threshold, or Best power efficiency on newer Windows 11 | ✅ Low Power Mode (asks for your Mac password) |
| **Power mode** <br><code>power_mode</code> | Choose best battery life, balanced, or best performance | ✅ Best power efficiency / Balanced / Best performance | ✅ Low Power Mode on or off (asks for your password) |
| **Lock the computer** <br><code>lock</code> | Lock the screen so a password is needed | ✅ | ✅ |
| **Sleep** <br><code>sleep</code> | Put the computer to sleep now | ✅ | ✅ |
| **Sleep and wake up later** <br><code>sleep_and_wake</code> | Put the computer to sleep now and wake it up by itself after some hours or minutes | ✅ Wake task in Task Scheduler + sleep | ✅ `pmset schedule wake` (asks for your password) + sleep |
| **Wake up later** <br><code>schedule_wake</code> | Set the computer to wake up by itself at a later time, without sleeping now | ✅ Wake task in Task Scheduler | ✅ `pmset schedule wake` (asks for your password) |
| **Hibernate** (asks first) <br><code>hibernate</code> | Hibernate: save everything to disk and power off | ✅ | — macOS hibernates on its own when the battery is low. |
| **Shut down** (asks first) <br><code>shutdown</code> | Turn the computer off, shut down | ✅ After 1 minute (can be cancelled) unless you say when | ✅ At once |
| **Restart** (asks first) <br><code>restart</code> | Restart or reboot the computer | ✅ After 1 minute (can be cancelled) unless you say when | ✅ At once |
| **Cancel shut down** <br><code>cancel_shutdown</code> | Stop a shutdown or restart that is counting down | ✅ | — macOS shuts down at once, so there is nothing to cancel. |
| **Sign out** (asks first) <br><code>sign_out</code> | Sign out or log off of this user account | ✅ | ✅ |

## System

| Action | What it does | Windows | macOS |
|---|---|---|---|
| **Check the computer** <br><code>system_info</code> | Say how busy the processor is, how much memory and disk space is free, and how long the computer has been on | ✅ | ✅ |
| **What uses the most memory** <br><code>top_processes</code> | List the programs using the most memory | ✅ | ✅ |
| **Stop a program** (asks first) <br><code>stop_program</code> | Force a frozen or heavy program to stop | ✅ | ✅ |
| **Show a notification** <br><code>notify</code> | Show a pop-up notification on the screen | ✅ | ✅ |
| **Empty the Recycle Bin** (asks first) <br><code>empty_trash</code> | Empty the Recycle Bin or Trash, deleting those files for good | ✅ | ✅ |

## Voice

Speech turns into text on this computer, for free and offline, with [Qwen3-ASR](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) running in llama.cpp `llama-server` (release b12189):

| Language | Model | Notes |
|---|---|---|
| Khmer | [seanghay/Qwen3-ASR-0.6B-Khmer](https://huggingface.co/seanghay/Qwen3-ASR-0.6B-Khmer) (GGUF Q8_0 by mradermacher) | About 2% character errors on its test set, 7.9% on other speech. Apache-2.0. |
| English, Korean | [ggml-org/Qwen3-ASR-0.6B-GGUF](https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF) Q8_0 | Apache-2.0. |

The first install downloads about 1.9 GB into the voice folder (`.local/voice`, or `REX_VOICE_DIR`). Each model starts on the first command, which takes a few seconds, answers in about a second after that, and stops after five quiet minutes so it does not hold memory.

## Jev anywhere: without opening Rex Desk

- **Windows:** turn on **Jev anywhere** at the top of the Computer control page. A small tray helper (`scripts/jev-anywhere.ps1`) starts now and with Windows (the per-user Run key, no admin). Press **Ctrl+Alt+J** in any app: the Jev bar opens at the top of the screen, listens, does the command, and closes itself. Press the keys again or Esc to close it. Clicking the tray icon opens it too. The helper starts the Rex Desk server when it is not running.
- **macOS:** turning it on adds a LaunchAgent that keeps the Rex Desk server running from login. For a key, make a Shortcuts shortcut that opens `http://127.0.0.1:4317/jev?listen=1&auto=1` and give it a keyboard shortcut.
- **Any terminal or script:** `npm run jev -- turn the volume down` (or `node bin/jev.js ...`). Add `--yes` for actions that ask first and `--json` for the full answer.

Jev uses the account that chose **Stay signed in** on this computer, so sign in that way once.

## Safety

- Only the person signed in to Rex Desk on this computer can use it; requests come from the dashboard on 127.0.0.1 only.
- Agents get the computer tools only after you allow them in Settings, and their "asks first" actions appear in **Needs you**.
- Rex Desk never stops its own server, Windows or macOS system processes.
- macOS asks for your password in its own dialog for Low Power Mode and scheduled wake; Rex Desk never sees it.
- Windows ignores clicks and typing sent to apps running as administrator; run Rex Desk as administrator only if you need that.
