package io.github.antonchuraev99.layoutdebug

import android.content.Context

/**
 * Release stand-in for the layout-debug agent: the same public API as `layout-debug-agent`,
 * with empty bodies and no dependencies. Code that calls [install] or reads [isRunning]
 * compiles in every build type, and the release APK carries no tool code.
 */
public object LayoutDebug {

    /** Always `false`: there is no agent in this build. */
    public val isRunning: Boolean
        get() = false

    /** Does nothing in this artifact. */
    @Suppress("UNUSED_PARAMETER")
    public fun install(context: Context) {
        // No agent in this build type.
    }
}
