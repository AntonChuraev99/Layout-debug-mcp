package io.github.antonchuraev99.layoutdebug.agent

import android.content.Context
import androidx.startup.Initializer
import io.github.antonchuraev99.layoutdebug.LayoutDebug

/**
 * Starts the agent with the app process, before `Application.onCreate` and before any
 * activity is composed. Registered in this library's manifest, so the app adds no code.
 */
internal class LayoutDebugInitializer : Initializer<Unit> {
    override fun create(context: Context) {
        LayoutDebug.install(context)
    }

    override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
