---
name: Bug report
about: Create a report to help us improve
title: ''
labels: ''
assignees: ''

---

**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Screenshots**
If applicable, add screenshots to help explain your problem.

**Debug log**
- In Settings screen of the Extension enable debug (Advanced tab)
- Then run `journalctl -f -o cat /usr/bin/gnome-shell | tee -a ~/gnome-shell.log`
- Repeat the situation / error or even crash you get.
- Include output of `~/gnome-shell.log` in your bug report please, you may need to login again to access it (in case of GNOME session issue).

**Information (please complete the following):**
 - Extension version: [e.g. v2.0]
 - Wayland or X11? If you don't know run `echo "$XDG_SESSION_TYPE`
 - GNOME version: [e.g. 46, 50]. If you don't know, run `gnome-shell --version`

**Additional context**
Add any other context about the problem here.