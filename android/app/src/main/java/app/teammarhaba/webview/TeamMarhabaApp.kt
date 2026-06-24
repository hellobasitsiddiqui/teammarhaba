package app.teammarhaba.webview

import android.app.Application

/**
 * Application entry point (TM-231). Currently minimal — a hook for future app-wide init (crash
 * reporting, FCM in a later ticket). Declared in the manifest so it exists from day one.
 */
class TeamMarhabaApp : Application()
