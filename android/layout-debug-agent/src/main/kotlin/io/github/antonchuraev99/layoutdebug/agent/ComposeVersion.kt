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

    /** A failure that is the agent's own bug, not a missing Compose API. */
    fun agentError(what: String, cause: Throwable): String =
        "layout-debug agent error: $what (${cause.javaClass.simpleName}: ${cause.message}) on $label, agent " +
            "$AGENT_VERSION. Please report it at https://github.com/AntonChuraev99/Layout-debug-mcp/issues with this message."

    /**
     * The message for [cause] thrown while using Compose internals: "not supported" only when
     * the API the agent links against or reflects into is missing or inaccessible (what a
     * different Compose version does), "agent error" for anything else.
     */
    fun failure(what: String, cause: Throwable): String {
        val real = unwrap(cause)
        return if (isMissingApi(real)) unsupported(what, real) else agentError(what, real)
    }

    /** Linkage and reflection failures: the Compose API is not there, or not reachable. Pure. */
    fun isMissingApi(t: Throwable): Boolean =
        t is LinkageError ||
            t is ReflectiveOperationException && t !is java.lang.reflect.InvocationTargetException

    /** The real cause of a reflective call, not the InvocationTargetException around it. */
    fun unwrap(t: Throwable): Throwable =
        (t as? java.lang.reflect.InvocationTargetException)?.targetException ?: t
}
