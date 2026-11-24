---
name: rex-setup-phone
description: Set up Rex Desk on the person's phone for them. A step-by-step playbook that checks what is already done, does what it can itself, walks the person through the rest in plain words with no terminal, and tests the phone end to end before saying it works.
---

# Set up Rex Desk on the phone

Use this when the person asks to use Rex Desk on their phone, or presses "Ask Rex Agent" on the Devices / phone screen. Your job is to get their phone opening their desk, doing as much yourself as you can and walking them through only the parts that need their hands. Never tell them to open a terminal.

There are two ways a phone reaches the desk. Pick one, do not set up both at once:

1. **Account (web.rexdesk.app), the easy way.** The phone opens `web.rexdesk.app`, signs in to the same Rex Desk account, and loads the desk through the relay. Works from anywhere, no Tailscale. Needs a Rex Desk account signed in on this computer and a plan that includes the phone.
2. **Tailscale, the free/local way.** The phone joins the same Tailscale network and opens this computer's address (or scans the QR). No account plan needed, but both devices need the Tailscale app on the same Tailscale login.

## First: is the account way open to this person?

Check this before choosing, so you never steer a free user toward an upgrade:
- Is a Rex Desk account signed in here? (Settings, Account and backup.)
- Does their plan include the relay? Read the phone status in Devices, Phone (the app's /api/phone-relay state). "Your plan does not include this" (state not-paid) means the plan excludes the relay.

Then pick:
- Signed in and the plan includes the relay: use the account way.
- Not signed in, or the plan excludes the relay: use the Tailscale way. It is free and needs no plan. Do not suggest upgrading; mention the account way only if the person asks about using the phone without Tailscale, and then say plainly it needs a plan that includes it (rexdesk.app). Never try to buy anything.

Ask the person which they want only if both ways are open and it is unclear.

## Before you start: check what is already done

Read the state instead of assuming. For the account way:
- The account is signed in and the plan includes the relay (checked above).
- Is the "Use Rex Desk on your phone" switch on? (Devices, Phone.)

For the Tailscale way:
- Is Tailscale installed and signed in on this computer? Check it (for example `tailscale status`). If the address is empty in Devices, Advanced, Connect over Tailscale, Tailscale is not running; open it and sign in.
- Does the person have the Tailscale app on their phone, on the same Tailscale login?

Do the checks you can run yourself first, then tell the person in one short list only the gaps that are left.

## Do what you can yourself

- Turn on the "Use Rex Desk on your phone" switch, or "Connect over Tailscale", through the app for them where you can.
- If Tailscale is installed but signed out, start it so the address appears. If it is not installed and the person wants the Tailscale way, offer to install it (with their OK), never by making them type commands.
- Get the QR code or the `web.rexdesk.app` link ready to show them.

## Walk the person through their part (no terminal)

Give them one small step at a time, in plain words:
- Account way: "On your phone, open web.rexdesk.app, sign in with the same account. Your phone will show a short code; I will approve it here." A new phone raises an approval with a code in Devices, Phone (and in Needs you). Approve it only if the code on the phone matches.
- Tailscale way: "Install Tailscale from the App Store or Play Store, sign in to the same Tailscale account, then scan this QR with your camera." The phone needs Tailscale on the same tailnet or it cannot reach the address.

## Test it end to end before saying it works

Do not declare success from settings alone. Confirm the phone actually opened the desk:
- Account way: check the phone shows up as an approved device in Devices, Phone, and ask the person to confirm their chats loaded on the phone.
- Tailscale way: ask the person to confirm the page opened and they can see and send a message.

If it failed, say what is still missing in one plain line and keep going from there. Only when the phone is really showing the desk do you tell the person it is set up, in one or two short sentences.
