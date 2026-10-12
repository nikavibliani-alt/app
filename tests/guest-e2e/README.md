# Guest page browser tests

Runs the real guest page (phone size) against the real guest functions code (`pipeline-functions/controllers/guestApi.js`,
`guestRegister.js`) with an in-memory database. No network, nothing is deployed.

    PLAYWRIGHT_PATH=/path/to/playwright CHROME_PATH=/path/to/chrome node tests/guest-e2e/suite.cjs
    ... suite2.cjs

What they check: the whole guest flow (find booking, sign, passport upload (no automatic scan any more), home screen), door code, Wi-Fi and elevator
code only after check-in, the old page and the new one show the same screen, wrong name or date, someone else's booking,
rate limit, passport over 10 MB, room move, two-room booking, join link.
