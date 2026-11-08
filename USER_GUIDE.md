# User guide — setting up and using your HomecoreOS controller

Everything below happens in a web browser. You do not install any software, and you never need a terminal.

You will do three things:

1. install the firmware on a new controller over USB (a one-time job),
2. connect the controller to your Wi-Fi and pair it with your account,
3. use — and later update — it from the website.

---

## 1. What you need

- A HomecoreOS controller board: **ESP32-S3 with 16 MB flash and 8 MB PSRAM (N16R8)**.
- A **USB data cable** (not a charge-only cable).
- A **computer with Chrome or Edge**. The in-browser installer uses a feature called Web Serial, which those browsers have and Safari, Firefox and phones do not.
- Your **Wi-Fi name and password**.
- A free account on your HomecoreOS site.

---

## 2. Install the firmware over USB (one-time)

1. Sign in to the website and open **Firmware**.
2. In **Option A · Install over USB in this browser**, click **Install over USB**.
3. Click **Download and verify**. The page downloads the release and compares it with the published checksum before anything is written. If the checksum does not match, stop — nothing was written.
4. Plug the controller into the computer with the USB cable.
5. If the board is not recognised, put it into **download mode**: hold the **BOOT** button, briefly press **RESET**, then release **BOOT**.
6. Click **Connect and install**. Your browser asks which serial port to use — pick the entry that looks like *USB JTAG/serial debug unit* or *CP210x*.
7. Watch the progress bar. It shows the real transfer, then reads the flash back and compares it with the published checksum.
8. Wait for **Written and verified**. Do not unplug the controller, close the tab or switch windows while the bar is moving.

If something fails, the page says what happened and nothing is claimed as installed. Plug the controller back into download mode and try again.

**Prefer to download the file?** The same page has **Save the file**, which gives you the image with its version, size, checksum and whether it is signed.

---

## 3. Connect it to your Wi-Fi

After the firmware is written, the controller restarts and creates its own temporary Wi-Fi network.

1. On a phone or laptop, open the Wi-Fi settings and join the network called **`HomecoreOS-Setup-…`**.
2. A setup page opens by itself. If it does not, open `http://192.168.4.1`.
3. Choose your home Wi-Fi network, type its password, and save.

Your Wi-Fi password is typed **on the controller's own setup page**. It is stored on the controller so it can reconnect by itself; it is never sent to the website.

---

## 4. Pair the controller with your account

Pairing proves the controller is yours. It uses a six-digit code.

1. In the website open **Firmware** (or the **Add a controller** wizard) and click **Get a pairing code**.
2. A six-digit code appears, with a countdown. It is valid for five minutes and can be used once.
3. On the controller's setup page, type the code and confirm.
4. The website notices the controller by itself. You will see it register, then come online.
5. The success message appears only after the controller actually reports that it is online. If the code expires first, click **New code**.

A controller that is not paired is not shown as a working device, and cannot be updated wirelessly.

---

## 5. Day-to-day use

| Page | What you do there |
| --- | --- |
| **Dashboard** | Live state of your home: which controllers are online, what is switched on, recent activity |
| **Controllers** | Each controller with its live status, firmware version and last contact |
| **Devices** | Switches, lights, sensors and covers, grouped by room |
| **Rooms** | Organise devices by room |
| **Automations** | Rules such as "when the hallway sensor sees motion, turn on the hallway light" |
| **Board library** | The pin map of your board and what each pin is used for |
| **Firmware** | Install or update firmware, pair a new controller, see update history |
| **Activity** | Everything that happened, with timestamps |
| **Settings** | Your account, password, recovery codes and appearance |

Two habits that save trouble:

- A card that says **offline** means the controller has not contacted the server recently. Check its power and Wi-Fi before anything else.
- Commands only take effect once. If a light did not change, the command probably arrived after the controller went offline; try again when it is back.

---

## 6. Updating firmware later

There are two ways, and both are safe to try.

**Wireless (normal case)**

1. Open **Firmware → Your controllers**.
2. A controller with a newer release shows **`<version>` available**.
3. Click **Update to `<version>`** and confirm.
4. The progress you see comes from the controller itself: downloading, installing, verifying, restarting.
5. The update only counts as finished after the controller reconnects and reports the new version. If it cannot connect on the new firmware, it goes back to the previous one by itself.

Your automations and device setup are kept: an update replaces the firmware, not your configuration.

**Over USB (only if wireless is not possible)**

Follow section 2 again. The installer recognises a controller that already runs HomecoreOS and writes only the firmware part, keeping the rest of the flash intact.

---

## 7. If something goes wrong

| What you see | What to do |
| --- | --- |
| *This browser cannot open a serial port* | Use Chrome or Edge on a desktop or laptop. Phones and Safari cannot do it. |
| The controller does not appear in the port list | Try another USB cable (a data cable), plug it straight into the computer rather than a hub, and put the board into download mode: hold **BOOT**, tap **RESET**, release **BOOT**. |
| *The connected board reports … but this release is built for …* | The release does not match your board. Nothing was written. Get the release for the ESP32-S3 N16R8 board. |
| *The flash does not hold the published build* | The write was interrupted. Leave the controller plugged in and install again. |
| The setup network does not appear | The controller did not finish starting. Unplug it, plug it in again, and look for `HomecoreOS-Setup-…` after about 15 seconds. |
| The code is rejected | Codes expire after five minutes and work once. Get a new code and type it within the countdown. |
| The controller goes **offline** after an update | It could not connect on the new firmware and returned to the previous version. Check your Wi-Fi, then try the update again. |
| The controller is online but a device does not respond | Open **Controllers** to confirm it is awake, then check the device's pin on the **Board library** page. |

---

## 8. Your data and your account

- Your Wi-Fi password stays on the controller.
- Your account password is stored only as a one-way hash; nobody, including the platform owner, can read it.
- Save the **recovery codes** you get at registration. With them you can set a new password yourself, without waiting for anyone.
- The owner of the platform can reset a password or issue new recovery codes for you if you are locked out; that action is recorded in an audit log.
