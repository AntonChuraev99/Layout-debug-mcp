package io.github.antonchuraev99.layoutdebug

import android.app.Application
import android.content.Context
import io.github.antonchuraev99.layoutdebug.agent.Agent

/**
 * The layout-debug on-device agent (debug builds only).
 *
 * Nothing to call in the usual setup: the agent starts by itself through androidx.startup
 * when the app process starts, and listens on `127.0.0.1:8790` for the desktop tool, which
 * reaches it through `adb forward`. Release builds use `layout-debug-noop`, which has the
 * same API with empty bodies.
 */
public object LayoutDebug {

    /** True once the agent's server is listening. */
    public val isRunning: Boolean
        get() = Agent.running

    /**
     * Starts the agent; safe to call more than once. Needed only when the app turned off
     * androidx.startup's automatic initialization: call it from `Application.onCreate`,
     * before the first activity is composed, or its screen has no slot tables to read.
     * Does nothing in a build that is not debuggable.
     */
    public fun install(context: Context) {
        Agent.install(context.applicationContext as Application)
    }
}
