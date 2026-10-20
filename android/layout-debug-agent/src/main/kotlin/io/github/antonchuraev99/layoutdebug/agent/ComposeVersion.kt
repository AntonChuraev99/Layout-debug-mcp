package io.github.antonchuraev99.layoutdebug.agent

/**
 * The Compose UI version the app actually runs, for error messages: the agent relies on
 * `@UiToolingDataApi` and on reflection into internal `LayoutNode` members, both of which a
 * Compose release may change. Every androidx artifact ships
 * `META-INF/androidx.compose.ui_ui.version` in the APK; read it once.
 */
internal object ComposeVersion {

    private const val RESOURCE = "META-INF/androidx.compose.ui_ui.version"

    val ui: String? by lazy {
        runCatching {
            ComposeVersion::class.java.classLoader
                ?.getResourceAsStream(RESOURCE)
                ?.bufferedReader()
                ?.use { it.readText().trim() }
                ?.takeIf { it.isNotEmpty() }
        }.getOrNull()
    }

    /** `Compose UI 1.12.1`, or why it is unknown. */
    val label: String get() = ui?.let { "Compose UI $it" } ?: "Compose UI (version unknown: no $RESOURCE in the APK)"

    /** An error for a Compose API the agent could not use: what failed, on which version, what to do. */
    fun unsupported(what: String, cause: Throwable? = null): String {
        val why = cause?.let { " (${it.javaClass.simpleName}: ${it.message})" } ?: ""
        return "$what on $label$why. This Compose version is not supported by layout-debug-agent $AGENT_VERSION: " +
            "see the compatibility table in the layout-debug-mcp README, or open an issue with this message."
    }
}
